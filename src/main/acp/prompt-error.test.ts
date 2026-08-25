import { describe, expect, it } from 'vitest'

import { describePromptError, isProviderPromptError } from './prompt-error'

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

    const text = describePromptError(error, { model: 'example-model' })

    expect(text).toContain('model "example-model"')
    expect(text).toContain('Settings → Model')
    // Surfaces the provider's own human message, not the raw JSON blob.
    expect(text).toContain('The requested resource was not found')
    expect(text).not.toContain('{')
  })

  it('handles a text-only (non-JSON) provider not-found and strips the wrapper prefixes', () => {
    const error = agentError('Internal error: Not Found: the requested model is unavailable')

    const text = describePromptError(error, { model: 'example-model' })

    expect(text).toContain('model "example-model"')
    // The provider's own message is surfaced verbatim (in whatever language it sent); only the
    // `Internal error:` and `Not Found:` wrapper prefixes are stripped from it.
    expect(text).toContain('the requested model is unavailable')
    expect(text).not.toMatch(/internal error:/i)
    expect(text).not.toMatch(/not found:/i)
  })

  it('extracts the provider message when the JSON payload has trailing text', () => {
    const error = agentError(
      'Internal error: Not Found: {"error":{"message":"The requested resource was not found","type":"resource_not_found_error"}} (request id: req-abc-123)'
    )

    const text = describePromptError(error, { model: 'example-model' })

    expect(text).toContain('The requested resource was not found')
    // Neither the raw JSON blob nor the trailing request id leaks into the surfaced text.
    expect(text).not.toContain('{')
    expect(text).not.toContain('request id')
  })

  it('passes through a benign "not found" API error that is not a resource lookup', () => {
    const error = agentError(
      'Internal error: Overloaded: rate limit config not found, using default'
    )

    expect(describePromptError(error, { model: 'example-model' })).toBe(
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

    expect(describePromptError(error, { model: 'example-model' })).toBe(
      'Internal error: Overloaded: service is busy'
    )
  })

  it('does not treat an ACP protocol not-found (no APIError tag) as a model problem', () => {
    // A plain session-not-found with no upstream signal must stay verbatim (the resume path owns it).
    const error = Object.assign(new Error('Resource not found'), { code: -32002 })

    expect(describePromptError(error)).toBe('Resource not found')
  })

  it('does not reword a -32002 protocol not-found even when it carries a JSON body', () => {
    // A parseable JSON body must not, on its own, promote a protocol not-found into a model problem.
    const error = Object.assign(new Error('Not Found: {"error":{"message":"session gone"}}'), {
      code: -32002
    })

    expect(describePromptError(error)).toBe('Not Found: {"error":{"message":"session gone"}}')
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

describe('isProviderPromptError', () => {
  it('flags an upstream APIError (auth/rate/quota/5xx all share this tag)', () => {
    expect(isProviderPromptError(agentError('Invalid API key'))).toBe(true)
    expect(isProviderPromptError(agentError('429 Too Many Requests'))).toBe(true)
    expect(isProviderPromptError(agentError('Internal error: Overloaded: service is busy'))).toBe(
      true
    )
  })

  it('flags a provider-relayed failure tagged with errorKind "provider-error"', () => {
    const error = Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { errorKind: 'provider-error' },
      name: 'RequestError'
    })

    expect(isProviderPromptError(error)).toBe(true)
  })

  it.each([400, 401, 422, 499])(
    'flags a Claude Code RequestError with an explicit provider %i status',
    (status) => {
      const error = agentError(`Internal error: API Error: ${status} Authentication Fails`, {
        errorKind: 'unknown'
      })

      expect(isProviderPromptError(error)).toBe(true)
    }
  )

  it.each(['ConnectionRefused', 'ECONNREFUSED', 'ENOTFOUND'])(
    'flags a Claude Code RequestError when the provider API is unreachable (%s)',
    (code) => {
      const error = agentError(`Internal error: API Error: Unable to connect to API (${code})`, {
        errorKind: 'unknown'
      })

      expect(isProviderPromptError(error)).toBe(true)
    }
  )

  it('does not infer a provider error from nearby but non-equivalent text', () => {
    expect(
      isProviderPromptError(
        agentError('Internal error: API Error: 500 Provider unavailable', {
          errorKind: 'unknown'
        })
      )
    ).toBe(false)
    expect(
      isProviderPromptError(
        agentError('Internal error: validation failed with status 400', {
          errorKind: 'unknown'
        })
      )
    ).toBe(false)
    expect(
      isProviderPromptError(
        agentError('Internal error: unable to connect to API (ConnectionRefused)', {
          errorKind: 'unknown'
        })
      )
    ).toBe(false)
    expect(
      isProviderPromptError(
        agentError('Internal error: Unable to connect to workspace (ConnectionRefused)', {
          errorKind: 'unknown'
        })
      )
    ).toBe(false)
    expect(
      isProviderPromptError(
        Object.assign(new Error('Internal error: API Error: 400 Invalid request'), {
          code: -32002,
          data: { errorKind: 'unknown' },
          name: 'RequestError'
        })
      )
    ).toBe(false)
    expect(isProviderPromptError(new Error('Internal error: API Error: 400 Invalid request'))).toBe(
      false
    )
    expect(
      isProviderPromptError(
        new Error('Internal error: API Error: Unable to connect to API (ConnectionRefused)')
      )
    ).toBe(false)
  })

  it('flags a provider resource-not-found (wrong model id / endpoint)', () => {
    const error = agentError(
      'Internal error: Not Found: {"error":{"message":"unknown model","type":"resource_not_found_error"}}'
    )

    expect(isProviderPromptError(error)).toBe(true)
  })

  it('does NOT flag an ACP-layer exception (no provider signal) — these stay reportable', () => {
    // A protocol not-found the resume path owns.
    expect(
      isProviderPromptError(Object.assign(new Error('Resource not found'), { code: -32002 }))
    ).toBe(false)
    // An app-layer throw with no agent tag.
    expect(isProviderPromptError(new Error('Agent session could not be created.'))).toBe(false)
    expect(isProviderPromptError('boom')).toBe(false)
  })
})

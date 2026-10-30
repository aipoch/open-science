import { classifyFailure } from '../../shared/failure/classify'
import { describe, expect, it } from 'vitest'
import { RequestError } from '@agentclientprotocol/sdk'

import {
  describePromptError,
  collectPromptFailureFacts,
  isOpenCodeSessionServiceFailure,
  withAgentAuthenticationRecovery
} from './prompt-error'

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

describe('provider origin', () => {
  it.each([
    [-32603, 'serverOverloaded', true],
    [-32002, 'serverOverloaded', false],
    [-32603, 'internalServerError', false],
    [-32603, undefined, false]
  ] as const)('classifies Codex code %s with detail %s structurally', (code, detail, expected) => {
    const error = Object.assign(
      new Error('Selected model is at capacity. Please try a different model.'),
      {
        code,
        data: { codexErrorInfo: detail },
        name: 'RequestError'
      }
    )
    expect(collectPromptFailureFacts(error).origin === 'provider').toBe(expected)
  })

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

    expect(collectPromptFailureFacts(error).origin === 'provider').toBe(true)
  })

  it.each([400, 401, 422, 499])(
    'flags a Claude Code RequestError with an explicit provider %i status',
    (status) => {
      const error = agentError(`Internal error: API Error: ${status} Authentication Fails`, {
        errorKind: 'unknown'
      })

      expect(collectPromptFailureFacts(error).origin === 'provider').toBe(true)
    }
  )

  it.each(['ConnectionRefused', 'ECONNREFUSED', 'ENOTFOUND'])(
    'flags a Claude Code RequestError when the provider API is unreachable (%s)',
    (code) => {
      const error = agentError(`Internal error: API Error: Unable to connect to API (${code})`, {
        errorKind: 'unknown'
      })

      expect(collectPromptFailureFacts(error).origin === 'provider').toBe(true)
    }
  )

  it('does not infer a provider error from nearby but non-equivalent text', () => {
    expect(
      isProviderPromptError(
        agentError('Internal error: API Error: 500 Provider unavailable', {
          errorKind: 'unknown'
        })
      )
    ).toBe(true)
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

    expect(collectPromptFailureFacts(error).origin === 'provider').toBe(true)
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

describe('OpenCode session failure classification', () => {
  it('keeps context overflow on the compaction recovery path', () => {
    expect(
      isOpenCodeSessionServiceFailure(
        agentError('context full', {
          service: 'session',
          errorName: 'ContextOverflowError'
        })
      )
    ).toBe(false)
    expect(
      isOpenCodeSessionServiceFailure(agentError('session missing', { service: 'session' }))
    ).toBe(true)
  })
})

describe('ACP authentication recovery boundary', () => {
  it.each([
    RequestError.authRequired(),
    RequestError.authRequired({ reason: 'expired' }, 'Sign in again'),
    agentError('Internal error', { details: 'workspace routing discovery unauthorized (401)' }),
    agentError('Internal error: API Error: 401 Unauthorized', { errorKind: 'unknown' }),
    Object.assign(new Error('Internal error: API Error: 401 Unauthorized'), {
      name: 'RequestError',
      code: -32603
    }),
    agentError('Provider rejected credentials', { errorName: 'APIError', statusCode: 401 }),
    agentError('Provider rejected credentials', { codexErrorInfo: 'unauthorized' }),
    agentError('Provider rejected credentials', {
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }
    })
  ])('normalizes a protocol-owned authentication failure before transport', async (error) => {
    expect(describePromptError(error)).toBe('Authentication required')
    expect(collectPromptFailureFacts(error).origin === 'provider').toBe(true)
    await expect(
      withAgentAuthenticationRecovery(async () => {
        throw error
      })
    ).rejects.toMatchObject({
      message: 'Authentication required',
      cause: error
    })
  })
  it.each([
    'Native Codex unavailable',
    'permission failed',
    'turn failed',
    'Authentication requiredness'
  ])('preserves generic -32000 errors: %s', async (message) => {
    const error = new RequestError(-32000, message)
    expect(describePromptError(error)).toBe(message)
    expect(collectPromptFailureFacts(error).origin === 'provider').toBe(false)
    await expect(
      withAgentAuthenticationRecovery(async () => {
        throw error
      })
    ).rejects.toBe(error)
  })
  it.each([
    agentError('Forbidden', { errorName: 'APIError', statusCode: 403 }),
    agentError('Rate limited', { errorName: 'APIError', statusCode: 429 }),
    agentError('Server failed', { errorName: 'APIError', statusCode: 503 }),
    agentError('Invalid client', { errorName: 'APIError', status: 401, error: 'invalid_client' }),
    agentError('Forbidden', {
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }
    }),
    agentError('Usage limit exceeded', { codexErrorInfo: 'usageLimitExceeded' }),
    agentError('Server overloaded', { codexErrorInfo: 'serverOverloaded' }),
    agentError('Unrelated protocol error', { codexErrorInfo: 'unauthorized' }, -32002),
    agentError('Malformed HTTP status', {
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: '401' } }
    }),
    agentError('Query returned 401 records', { details: '401' }),
    Object.assign(new Error('unrelated RPC'), { code: -32000 })
  ])('preserves other failures', (error) => {
    expect(describePromptError(error)).toBe(error.message)
  })
})

describe('classified failure facts across agent execution paths', () => {
  it.each([
    [
      'claude-code',
      agentError('Internal error: API Error: 401 Unauthorized', { errorKind: 'unknown' }),
      'configuration',
      401
    ],
    [
      'opencode',
      agentError('upstream failure', {
        errorName: 'APIError',
        statusCode: 429,
        requestId: 'request-example'
      }),
      'service',
      429
    ],
    [
      'codex-response',
      agentError('upstream failure', {
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        errorKind: 'provider-error'
      }),
      'service',
      503
    ],
    [
      'codex-bridge',
      agentError('upstream failure', { errorKind: 'provider-error', status: 403 }),
      'configuration',
      403
    ]
  ] as const)(
    'captures and classifies the %s wire shape',
    (_framework, error, category, status) => {
      const facts = collectPromptFailureFacts(error, { model: 'example-model' })
      expect(facts.status).toBe(status)
      expect(facts.model).toBe('example-model')
      expect(classifyFailure(facts).category).toBe(category)
    }
  )
  it('keeps an opaque protocol error internal even when its prose mentions a status', () => {
    expect(
      classifyFailure(collectPromptFailureFacts(agentError('Record 503 could not be decoded', {})))
        .category
    ).toBe('internal')
  })
})

const isProviderPromptError = (error: unknown): boolean =>
  collectPromptFailureFacts(error).origin === 'provider'

describe('native framework failure facts', () => {
  it.each([
    [{ service: 'session', errorName: 'APIError', statusCode: 401 }, 'configuration'],
    [{ service: 'session', errorName: 'APIError', statusCode: 429 }, 'service'],
    [
      { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, message: 'Rejected' },
      'configuration'
    ],
    [
      { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, message: 'Unavailable' },
      'service'
    ],
    [{ codexErrorInfo: 'usageLimitExceeded', message: 'Limit reached' }, 'configuration'],
    [{ codexErrorInfo: 'contextWindowExceeded', message: 'Too long' }, 'input'],
    [{ codexErrorInfo: 'internalServerError', message: 'Protocol inconsistency' }, 'internal']
  ] as const)('classifies native data without an invented provider flag: %j', (data, category) => {
    const facts = collectPromptFailureFacts(agentError('Internal error', data))
    expect(classifyFailure(facts).category).toBe(category)
  })
})

describe('compatibility bridge upstream status preservation', () => {
  // Compose the bridge's tested HTTP body with each adapter's tested RequestError boundary.
  // These are deterministic boundary fixtures, not a captured native model invocation.
  for (const path of ['codex-bridge', 'claude-code'] as const) {
    it.each([
      [401, 'configuration'],
      [403, 'configuration'],
      [404, 'configuration'],
      [413, 'input']
    ] as const)(
      `${path} restores original status %i from the typed bridge envelope`,
      (status, category) => {
        const payload = JSON.stringify({
          error: { type: 'upstream_error', message: 'Upstream request rejected', status }
        })
        const error =
          path === 'codex-bridge'
            ? RequestError.internalError(
                { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } },
                `400 Bad Request: ${payload}`
              )
            : agentError(`Internal error: API Error: 400 ${payload}`, { errorKind: 'unknown' })
        const facts = collectPromptFailureFacts(error)
        expect(facts.status).toBe(status)
        expect(classifyFailure(facts).category).toBe(category)
      }
    )
  }
  it.each([
    { type: 'other_error', status: 401 },
    { type: 'upstream_error', status: '401' },
    { type: 'upstream_error', status: 999 }
  ])('rejects an unrelated or invalid nested status %j', (payload) => {
    const error = RequestError.internalError(
      { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } },
      JSON.stringify({ error: { message: 'Rejected', ...payload } })
    )
    expect(collectPromptFailureFacts(error).status).toBe(400)
  })
  it('does not turn an unowned ACP payload into a provider error', () => {
    const error = RequestError.resourceNotFound('file:///missing')
    expect(classifyFailure(collectPromptFailureFacts(error)).category).toBe('internal')
  })
})

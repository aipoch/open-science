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

  it('surfaces a structured provider message from a generic API error wrapper', () => {
    const error = agentError(
      'Internal error: API Error: 400 {"error":{"message":"tool schema is invalid","type":"invalid_request_error"}}',
      { errorKind: 'provider-error' }
    )

    expect(describePromptError(error, { model: 'deepseek-flash' })).toBe(
      'Provider error for model "deepseek-flash" (HTTP 400): tool schema is invalid'
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
  it('keeps an ambiguous provider resource-not-found distinct from an unavailable model', () => {
    const message = 'Example deployment unavailable'
    const error = RequestError.internalError(
      { errorName: 'APIError' },
      JSON.stringify({ error: { type: 'resource_not_found_error', message } })
    )
    expect(classifyFailure(collectPromptFailureFacts(error))).toEqual({
      category: 'service',
      reason: 'service/provider-error',
      responseMessage: message,
      diagnostics: { code: 'resource_not_found_error', raw: error.message }
    })
  })
  it.each([
    ['Upstream is busy', 'Upstream is busy'],
    ['{"message":"Busy","code":"example_busy"}', 'Busy'],
    ['{"detail":["busy"]}', '{"detail":["busy"]}']
  ])(
    'preserves the tagged provider response body and extracts available message text: %s',
    (body, message) => {
      const failure = classifyFailure(
        collectPromptFailureFacts(RequestError.internalError({ service: 'provider' }, body), {
          providerName: 'Example Provider',
          model: 'example-model'
        })
      )
      expect(failure).toEqual({
        category: 'service',
        reason: 'service/provider-error',
        responseMessage: message,
        diagnostics: {
          provider: 'Example Provider',
          model: 'example-model',
          raw: 'Internal error: ' + body
        }
      })
    }
  )
  it.each([
    [undefined, 'internal', '-32603'],
    [{ errorKind: 'unknown', status: 503 }, 'internal', '-32603'],
    [{ codexErrorInfo: 'internalServerError' }, 'internal', 'internalServerError'],
    [{ service: 'session', errorName: 'UnknownError' }, 'session', '-32603']
  ] as const)(
    'keeps the original recovery path without provider ownership: %j',
    (data, category, code) => {
      const error = RequestError.internalError(data, '{"message":"Busy","code":"example_busy"}')
      const failure = classifyFailure(
        collectPromptFailureFacts(error, {
          providerName: 'Example Provider',
          model: 'example-model'
        })
      )
      expect(failure).toMatchObject({ category, diagnostics: { code, raw: error.message } })
      expect(failure.responseMessage).toBeUndefined()
    }
  )
  it('keeps ACP sign-in recovery when the authentication error carries JSON', () => {
    const error = RequestError.authRequired(undefined, '{"message":"Sign in again"}')
    const failure = classifyFailure(collectPromptFailureFacts(error))
    expect(failure.reason).toBe('configuration/auth-failed')
    expect(failure.responseMessage).toBeUndefined()
  })
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
  it('recognizes the terminal connection failure reported by codex-acp 1.6.2 after 502 retries', () => {
    const message =
      'unexpected status 502 Bad Gateway: Could not connect to the model provider, url: http://127.0.0.1:43210/v1/responses'
    const error = agentError('Internal error: ' + message, { message, codexErrorInfo: 'other' })
    const failure = classifyFailure(collectPromptFailureFacts(error, { model: 'fixture' }))
    expect(failure).toMatchObject({
      reason: 'service/connection-failed',
      diagnostics: { model: 'fixture' }
    })
    expect(JSON.stringify(failure)).not.toContain('127.0.0.1')
    expect(describePromptError(error)).not.toContain('127.0.0.1')
  })

  it.each([502, 503])('preserves a relayed HTTP %i when Codex flattens its body', (status) => {
    const label = status === 502 ? 'Bad Gateway' : 'Service Unavailable'
    const message = `unexpected status ${status} ${label}: Upstream HTTP ${status}: Upstream gateway unavailable, url: http://127.0.0.1:43210/v1/responses`
    const error = agentError('Internal error: ' + message, { message, codexErrorInfo: 'other' })
    const failure = classifyFailure(
      collectPromptFailureFacts(error, { model: 'fixture', providerName: 'Example Provider' })
    )
    expect(failure).toMatchObject({
      reason: 'service/unavailable',
      responseMessage: 'Upstream gateway unavailable',
      diagnostics: { status, model: 'fixture', provider: 'Example Provider' }
    })
    expect(JSON.stringify(failure)).not.toContain('127.0.0.1')
    expect(describePromptError(error)).not.toContain('127.0.0.1')
  })

  it('does not attribute a local response conversion failure to upstream HTTP', () => {
    const message =
      'unexpected status 502 Bad Gateway: The model service returned invalid JSON., url: http://127.0.0.1:43210/v1/responses'
    const facts = collectPromptFailureFacts(
      agentError('Internal error: ' + message, { message, codexErrorInfo: 'other' })
    )
    expect(facts.status).toBeUndefined()
    expect(facts.origin).not.toBe('provider')
  })

  it('restores a typed 401 when Codex reports the bridge envelope as other', () => {
    const message = JSON.stringify({
      error: { type: 'upstream_error', status: 401, message: 'Credentials rejected' }
    })
    const failure = classifyFailure(
      collectPromptFailureFacts(
        agentError('Internal error: ' + message, { message, codexErrorInfo: 'other' })
      )
    )
    expect(failure).toMatchObject({
      reason: 'configuration/auth-failed',
      diagnostics: { status: 401 }
    })
  })

  it('recognizes the native Codex high-demand failure after an upstream 500', () => {
    const message = 'We’re currently experiencing high demand, which may cause temporary errors.'
    const failure = classifyFailure(
      collectPromptFailureFacts(
        agentError('Internal error: ' + message, { message, codexErrorInfo: 'internalServerError' })
      )
    )
    expect(failure.reason).toBe('service/unavailable')
    expect(failure.diagnostics.status).toBeUndefined()
  })

  // Compose the bridge's tested HTTP body with each adapter's tested RequestError boundary.
  // These are deterministic boundary fixtures, not a captured native model invocation.
  for (const path of ['codex-bridge', 'claude-code'] as const) {
    it.each([
      [401, 'configuration'],
      [402, 'configuration'],
      [403, 'configuration'],
      [404, 'service'],
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
  it('carries the safe explanation from a relayed provider error into the user notice', () => {
    const safe = "Unsupported parameter: 'temperature'"
    const body = JSON.stringify({
      error: {
        type: 'upstream_error',
        message: safe + '. PRIVATE_PROMPT user@example.test',
        status: 400
      }
    })
    const failure = classifyFailure(
      collectPromptFailureFacts(agentError('Internal error: ' + body, { message: body }))
    )
    expect(failure.responseMessage).toBe(safe)
    expect(failure.reason).toBe('configuration/request-invalid')
    expect(failure.diagnostics.status).toBe(400)
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_PROMPT|user@example.test/)
  })

  it('classifies an untagged upstream billing envelope by its HTTP status', () => {
    const body = JSON.stringify({
      error: {
        type: 'upstream_error',
        message: 'Insufficient Balance (request_id: request-402)',
        status: 402
      }
    })
    const failure = classifyFailure(
      collectPromptFailureFacts(agentError(body, { errorKind: 'unknown' }))
    )
    expect(failure).toMatchObject({
      category: 'configuration',
      reason: 'configuration/billing',
      responseMessage: 'Insufficient Balance (request_id: request-402)',
      diagnostics: { status: 402 }
    })
    expect(failure.diagnostics.code).toBeUndefined()
    expect(failure.diagnostics.raw).toContain('"type":"upstream_error"')
    expect(failure.diagnostics.raw).toContain('Insufficient Balance')
  })

  it.each([
    [400, 'configuration', 'configuration/request-invalid'],
    [401, 'configuration', 'configuration/auth-failed'],
    [402, 'configuration', 'configuration/billing'],
    [403, 'configuration', 'configuration/auth-failed'],
    [404, 'service', 'service/provider-error'],
    [413, 'input', 'input/context-overflow'],
    [422, 'configuration', 'configuration/request-invalid'],
    [429, 'service', 'service/rate-limited'],
    [500, 'service', 'service/unavailable']
  ] as const)(
    'uses an explicit upstream HTTP status %i for classification',
    (status, category, reason) => {
      const body = JSON.stringify({
        error: { type: 'upstream_error', message: 'Provider request failed', status }
      })
      const failure = classifyFailure(
        collectPromptFailureFacts(agentError(body, { errorKind: 'unknown' }))
      )
      expect(failure).toMatchObject({ category, reason, diagnostics: { status } })
    }
  )

  it('attributes a confirmed upstream stack error to the model service', () => {
    const body = JSON.stringify({
      error: { type: 'upstream_error', message: 'Maximum call stack size exceeded', status: 400 }
    })
    const failure = classifyFailure(
      collectPromptFailureFacts(agentError('Internal error: ' + body, { message: body }))
    )
    expect(failure).toMatchObject({
      reason: 'service/provider-error',
      responseMessage: 'Maximum call stack size exceeded'
    })
  })

  it('recognizes the bridge response-format error relayed without an HTTP status', () => {
    const body = JSON.stringify({
      error: {
        type: 'invalid_upstream_response',
        message: 'The model service returned invalid JSON.'
      }
    })
    const error = agentError('Internal error: ' + body, { message: body })
    const failure = classifyFailure(collectPromptFailureFacts(error))
    expect(failure.reason).toBe('service/response-invalid')
    expect(failure.diagnostics.status).toBeUndefined()
    expect(failure.responseMessage).toBeUndefined()
  })

  it('distinguishes a malformed upstream response from service downtime at the ACP boundary', () => {
    const payload = JSON.stringify({
      error: {
        type: 'invalid_upstream_response',
        message: 'The model service returned invalid JSON.'
      }
    })
    const error = RequestError.internalError(
      { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } },
      '502 Bad Gateway: ' + payload
    )
    const failure = classifyFailure(collectPromptFailureFacts(error))
    expect(failure.responseMessage).toBeUndefined()
    expect(failure).toMatchObject({
      category: 'service',
      reason: 'service/response-invalid',
      diagnostics: { status: 502, code: 'invalid_upstream_response' }
    })
  })

  it('does not turn an unowned ACP payload into a provider error', () => {
    const error = RequestError.resourceNotFound('file:///missing')
    expect(classifyFailure(collectPromptFailureFacts(error)).category).toBe('internal')
  })
})

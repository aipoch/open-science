import { describe, expect, it } from 'vitest'
import { classifyFailure } from './classify'
import type { FailureCategory, FailureFacts, FailureReason } from './contract'
import { CLAUDE_CLI_INCOMPATIBLE_MESSAGE } from '../claude-runtime'
import {
  buildUnsupportedCodexAcpVersionMessage,
  CODEX_CLI_INCOMPATIBLE_MESSAGE
} from '../codex-runtime'

const cases: [FailureCategory, FailureFacts][] = [
  ['configuration', { origin: 'provider', status: 401 }],
  ['configuration', { origin: 'provider', status: 403 }],
  ['service', { origin: 'provider', status: 404 }],
  ['configuration', { origin: 'provider', code: 'invalid_api_key' }],
  ['configuration', { origin: 'provider', code: 'insufficient_quota' }],
  ['configuration', { origin: 'provider', text: 'API key missing' }],
  ['configuration', { origin: 'provider', text: 'model_not_found' }],
  ['configuration', { origin: 'provider', text: 'credit balance is too low' }],
  ['configuration', { origin: 'agent-runtime', text: CLAUDE_CLI_INCOMPATIBLE_MESSAGE }],
  ['configuration', { origin: 'agent-runtime', text: CODEX_CLI_INCOMPATIBLE_MESSAGE }],
  [
    'configuration',
    { origin: 'agent-runtime', text: buildUnsupportedCodexAcpVersionMessage('1.0.0') }
  ],
  ['service', { origin: 'provider', status: 429 }],
  ['service', { origin: 'provider', status: 529 }],
  ['service', { origin: 'provider', text: 'ETIMEDOUT' }],
  ['service', { origin: 'provider', text: 'connection reset' }],
  [
    'service',
    { origin: 'agent-runtime', text: 'Internal error: API Error: Connection closed mid-response' }
  ],
  ['environment', { origin: 'operation', text: 'Python environment missing' }],
  ['environment', { origin: 'operation', text: 'conda environment corrupt' }],
  ['environment', { origin: 'operation', text: 'Notebook kernel failed to start' }],
  ['environment', { origin: 'operation', text: 'No module named ipykernel_launcher' }],
  ['environment', { origin: 'operation', text: 'sandbox not ready' }],
  ['environment', { origin: 'operation', text: 'WSL not installed' }],
  ['environment', { origin: 'operation', code: 'ENOSPC' }],
  ['environment', { origin: 'operation', code: 'EACCES' }],
  ['input', { origin: 'provider', status: 413 }],
  ['input', { origin: 'provider', text: 'maximum context length exceeded' }],
  [
    'input',
    {
      origin: 'operation',
      text: 'The attached image is too large to prepare for the Vision model.'
    }
  ],
  ['input', { origin: 'operation', text: 'unsupported attachment type' }],
  ['session', { origin: 'session', text: 'connection lost' }],
  ['internal', { origin: 'agent-runtime', code: -32002 }],
  ['session', { origin: 'operation', text: 'Session was interrupted before the app closed.' }],
  ['internal', { origin: 'agent-runtime', code: -32603, text: 'tool call state mismatch' }]
]

describe('classifyFailure', () => {
  it.each<[FailureFacts, FailureReason]>([
    [
      {
        origin: 'provider',
        status: 400,
        responseMessage: "Model v4.1 isn't included in this plan."
      },
      'configuration/model-unavailable'
    ],
    [
      { origin: 'provider', status: 400, code: 'model_unavailable' },
      'configuration/model-unavailable'
    ],
    [
      { origin: 'provider', status: 404, responseMessage: 'Model old has been retired' },
      'configuration/model-unavailable'
    ],
    [
      { origin: 'provider', status: 404, responseMessage: 'Endpoint /v1/wrong not found' },
      'configuration/endpoint-invalid'
    ],
    [
      { origin: 'provider', status: 404, responseMessage: 'Resource not found' },
      'service/provider-error'
    ],
    [
      { origin: 'provider', status: 422, responseMessage: 'Invalid temperature' },
      'configuration/request-invalid'
    ],
    [
      { origin: 'provider', status: 400, code: 'context_window_exceeded' },
      'input/context-overflow'
    ],
    [{ origin: 'provider', status: 429, code: 'insufficient_quota' }, 'configuration/billing'],
    [
      { origin: 'provider', status: 402, responseMessage: 'Insufficient Balance' },
      'configuration/billing'
    ],
    [{ origin: 'provider', protocol: 'chat-completions', status: 402 }, 'configuration/billing'],
    [
      { origin: 'provider', protocol: 'chat-completions', status: 400, code: 'model_not_found' },
      'configuration/model-unavailable'
    ],
    [{ origin: 'provider', responseMessage: 'Insufficient Balance' }, 'configuration/billing'],
    [{ origin: 'provider', code: 'overloaded_error' }, 'service/unavailable'],
    [
      {
        origin: 'provider',
        status: 400,
        responseMessage: 'Authentication Fails, Your api key: ****e52d is invalid'
      },
      'configuration/auth-failed'
    ],
    [
      { origin: 'provider', responseMessage: 'Python environment missing' },
      'service/provider-error'
    ],
    [{ origin: 'provider', responseMessage: 'Session not found' }, 'service/provider-error'],
    [
      { origin: 'provider', adapterCode: 'network', phase: 'response' },
      'service/connection-failed'
    ],
    [
      { origin: 'provider', adapterCode: 'network', phase: 'stream' },
      'service/response-interrupted'
    ],
    [
      { origin: 'provider', adapterCode: 'protocol', phase: 'missing-done' },
      'service/response-invalid'
    ],
    [
      { origin: 'provider', adapterCode: 'protocol', phase: 'provider', code: 'new_error' },
      'service/provider-error'
    ]
  ])('classifies structured provider facts %j as %s', (facts, reason) => {
    expect(classifyFailure(facts).reason).toBe(reason)
  })
  it.each(cases)('recognizes %s from %j', (category, facts) => {
    expect(classifyFailure(facts).category).toBe(category)
  })
  it.each([401, 403, 429, 500, 503, 529])(
    'prefers structured provider status %i over prose',
    (status) => {
      expect(
        classifyFailure({ origin: 'provider', status, text: 'prompt is too long; invalid API key' })
          .category
      ).toBe(status < 429 ? 'configuration' : 'service')
    }
  )
  it.each([
    'Failed to parse rate limit configuration',
    'Record 503 could not be decoded',
    'Billing planner initialization failed',
    'Scheduler crashed while overloaded with tasks',
    'Model is unavailable'
  ])('keeps unrelated app failures internal: %s', (text) => {
    expect(classifyFailure({ origin: 'operation', text }).category).toBe('internal')
  })
  it('retains diagnostics without mutating the input', () => {
    const facts = Object.freeze({
      origin: 'provider' as const,
      status: 401,
      code: -32603,
      provider: 'Example',
      model: 'test-model',
      requestId: 'request-1',
      text: 'raw detail'
    })
    expect(classifyFailure(facts)).toEqual({
      category: 'configuration',
      reason: 'configuration/auth-failed',
      diagnostics: {
        status: 401,
        code: '-32603',
        provider: 'Example',
        model: 'test-model',
        requestId: 'request-1',
        raw: 'raw detail'
      }
    })
  })
  it('defaults opaque provider failures to service and other failures to internal', () => {
    expect(classifyFailure({ origin: 'provider' })).toEqual({
      category: 'service',
      reason: 'service/provider-error',
      diagnostics: {}
    })
    expect(classifyFailure({ origin: 'operation' })).toEqual({
      category: 'internal',
      diagnostics: {}
    })
  })
})

it.each(['Upload timed out', 'Bookmark connection failed'])(
  'does not treat an ordinary operation as session recovery: %s',
  (text) => {
    expect(classifyFailure({ origin: 'operation', text }).category).toBe('internal')
  }
)

it('keeps a structured size failure ahead of unrelated provider prose', () => {
  expect(
    classifyFailure({
      origin: 'provider',
      status: 413,
      text: 'The payload contains an example invalid API key.'
    }).category
  ).toBe('input')
})

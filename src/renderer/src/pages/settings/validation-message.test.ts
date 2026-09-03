import { describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { describeValidation, localizeProviderResourceMessage } from './validation-message'

// English is pinned by test/setup-i18n.ts; these assertions are the guard that the catalog round-trip
// leaves the user-visible copy byte-identical to what it was before it moved out of the module.
const t = i18next.getFixedT('en')

describe('describeValidation', () => {
  it('uses a custom auth message verbatim when one is supplied', () => {
    expect(
      describeValidation(
        {
          ok: false,
          category: 'auth',
          message: 'Custom auth message from the probe.'
        },
        t
      )
    ).toBe('Custom auth message from the probe.')
  })

  it('keeps the generic API-key guidance for HTTP auth failures', () => {
    expect(describeValidation({ ok: false, category: 'auth', status: 401 }, t)).toBe(
      'Authentication failed. Check the API key. (HTTP 401)'
    )
  })

  it('surfaces the gateway message for an unknown failure instead of the generic copy', () => {
    expect(
      describeValidation(
        {
          ok: false,
          category: 'unknown',
          status: 402,
          message: 'Insufficient Balance'
        },
        t
      )
    ).toBe('Insufficient Balance (HTTP 402)')
  })

  it('falls back to the generic unknown copy when no message is present', () => {
    expect(describeValidation({ ok: false, category: 'unknown', status: 402 }, t)).toBe(
      'Validation failed for an unknown reason. (HTTP 402)'
    )
  })

  it('surfaces the specific route-mismatch reason for an incompatible pairing', () => {
    expect(
      describeValidation(
        {
          ok: false,
          category: 'incompatible',
          message:
            'Not compatible with Claude Code: it needs /v1/messages, but this provider speaks /v1/chat/completions. Change the API format or switch the agent framework.'
        },
        t
      )
    ).toBe(
      'Not compatible with Claude Code: it needs /v1/messages, but this provider speaks /v1/chat/completions. Change the API format or switch the agent framework.'
    )
  })

  it('falls back to the generic incompatible copy when no reason is supplied', () => {
    expect(describeValidation({ ok: false, category: 'incompatible' }, t)).toBe(
      "This provider isn't compatible with the active agent framework."
    )
  })

  it('localizes an application-generated provider resource-limit message', () => {
    expect(
      describeValidation(
        {
          ok: false,
          category: 'unknown',
          message: 'Provider validation response exceeded 1048576 bytes.'
        },
        i18next.getFixedT('zh-Hans')
      )
    ).toBe('服务商校验响应超过 1048576 字节。')
  })
})

describe('localizeProviderResourceMessage', () => {
  it.each([
    ['Base URL must be a valid HTTP or HTTPS URL.', '基础 URL 必须是有效的 HTTP 或 HTTPS URL。'],
    [
      'Remove credentials from the Base URL and use the API key field.',
      '请从基础 URL 中移除凭据，改用 API 密钥字段。'
    ]
  ])('localizes a custom provider Base URL error', (message, expected) => {
    expect(localizeProviderResourceMessage(message, i18next.getFixedT('zh-Hans'))).toBe(expected)
  })
})

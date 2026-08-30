import type { TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import { localizeConnectorError } from './connector-error-message'

describe('localizeConnectorError', () => {
  it('localizes the aggregate credential argument diagnostic', () => {
    const t = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction

    expect(localizeConnectorError('args appears to contain a credential.', t)).toBe(
      'translated:args appears to contain a credential.'
    )
    expect(t).toHaveBeenCalledWith('args appears to contain a credential.')
  })

  it.each([
    'Duplicate credential names are not allowed on this platform.',
    'Remote MCP server URL must use HTTPS or loopback HTTP.'
  ])('localizes custom Connector security validation errors: %s', (message) => {
    const t = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction

    expect(localizeConnectorError(message, t)).toBe(`translated:${message}`)
    expect(t).toHaveBeenCalledWith(message)
  })
})

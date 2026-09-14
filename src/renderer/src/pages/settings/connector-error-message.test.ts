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
    'Credential changes were saved, but Connectors could not refresh. Retry from Settings > Connectors.',
    'MCP server configuration must be an object.',
    'MCP server environment variables must be an object.',
    'MCP server headers must be an object.',
    'Unsupported MCP transport.',
    'MCP server must define either command or url.',
    'MCP server transport does not match its connection fields.',
    'MCP server names must remain unique after normalization.',
    'MCP server name was normalized for Open Science.',
    'Credential values were excluded and must be entered locally.',
    'The MCP client configuration must contain at least one server.',
    'MCP Registry server.json manifests cannot be imported as installed MCP client configurations.',
    'OAuth registration and OAuth tokens were excluded from the MCP client configuration.',
    'Authorization server URL is required for a pre-registered client.',
    'Client metadata URL cannot be combined with a pre-registered client.',
    'Client ID is required when a client secret is configured.',
    'OAuth redirect URI must be a valid URL.',
    'OAuth redirect URI must be an http://127.0.0.1 loopback URL.',
    'OAuth redirect URI requires a pre-registered client ID.',
    'Secure credential storage is unavailable. Unlock the system keychain and retry.',
    'Credentials in arguments or URLs are not allowed. Use encrypted environment or header fields instead.',
    'Duplicate credential names are not allowed on this platform.',
    'Remote MCP server URL must use HTTPS or loopback HTTP.'
  ])('localizes Connector validation and recovery feedback: %s', (message) => {
    const t = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction

    expect(localizeConnectorError(message, t)).toBe(`translated:${message}`)
    expect(t).toHaveBeenCalledWith(message)
  })

  it.each([
    'Connector name must not exceed 128 characters.',
    'Connector environment must not exceed 64 entries.',
    'OAuth client metadata must not exceed 4096 bytes.'
  ])('localizes a bounded-size diagnostic: %s', (message) => {
    const translate = vi.fn((key: string) => `translated:${key}`)
    expect(localizeConnectorError(message, translate as unknown as TFunction)).toBe(
      'translated:Connector configuration exceeds the allowed size.'
    )
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      'Connector configuration exceeds the allowed size.'
    )
  })

  it('localizes a numeric custom Connector limit', () => {
    const translate = vi.fn((key: string) => `translated:${key}`)
    expect(
      localizeConnectorError(
        'Custom Connector limit of 24 reached.',
        translate as unknown as TFunction
      )
    ).toBe('translated:The maximum number of custom Connectors has been reached.')
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      'The maximum number of custom Connectors has been reached.'
    )
  })

  it.each([
    '',
    'Connection refused by server.',
    'Prefix: Connector name must not exceed 128 characters.',
    'OAuth client metadata must not exceed 4096 bytes. Additional details.',
    'Connector name must not exceed many characters.',
    'Custom Connector limit of 24 reached. Retry later.'
  ])('preserves unknown or partial-match diagnostics verbatim: %s', (message) => {
    const translate = vi.fn()
    expect(localizeConnectorError(message, translate as unknown as TFunction)).toBe(message)
    expect(translate).not.toHaveBeenCalled()
  })
})

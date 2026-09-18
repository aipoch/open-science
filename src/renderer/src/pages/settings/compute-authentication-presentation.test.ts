import type { TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import {
  computeAuthenticationPresentation,
  isComputeAuthenticationErrorCode
} from './compute-authentication-presentation'

describe('isComputeAuthenticationErrorCode', () => {
  it('rejects properties inherited from Object.prototype', () => {
    expect(isComputeAuthenticationErrorCode('toString')).toBe(false)
    expect(isComputeAuthenticationErrorCode('authentication_failed')).toBe(true)
  })

  it.each([undefined, null, 1, {}, [], '', 'unknown_error', 'constructor', '__proto__'])(
    'rejects an unrecognized error code: %j',
    (value) => {
      expect(isComputeAuthenticationErrorCode(value)).toBe(false)
    }
  )
})

describe('Compute authentication presentation', () => {
  it.each([
    [
      'credential_required',
      'Configure a password for this Compute Host before trying again.',
      'Manage credentials'
    ],
    [
      'credential_unavailable',
      'The saved credential cannot be used on this device. Replace it and test again.',
      'Manage credentials'
    ],
    [
      'secure_storage_unavailable',
      'Unlock system credential storage, then test the connection again.',
      'Manage credentials'
    ],
    [
      'authentication_failed',
      'The saved username or password was rejected. Update it before trying again.',
      'Manage credentials'
    ],
    [
      'credential_conflict',
      'Credentials changed in another window. Reload this Host before continuing.',
      'Manage credentials'
    ],
    [
      'credential_change_blocked_by_jobs',
      'Authentication change blocked. Finish or safely delete active and unharvested Compute Jobs first.',
      'Manage credentials'
    ],
    [
      'host_key_unknown',
      'Verify this Host key in a terminal before connecting from Open-Science.',
      'Review Host settings'
    ],
    [
      'host_key_changed',
      'Verify the changed Host key in known hosts before connecting again.',
      'Review Host settings'
    ],
    [
      'host_unreachable',
      'Check the Host address and network connection, then try again.',
      'Review connection settings'
    ],
    [
      'timeout',
      'The connection timed out. Check the network or Host load, then try again.',
      'Review connection settings'
    ],
    [
      'create_failed',
      'The Compute Host could not be added. Review its configuration and try again.',
      'Review Host settings'
    ],
    ['reset_failed', 'Could not update the saved password.', 'Manage credentials'],
    [
      'unsupported_auth_configuration',
      'This authentication setup is not supported. Review the Host configuration.',
      'Review Host settings'
    ]
  ] as const)(
    'selects the runtime recovery instruction and action for %s',
    (code, copy, action) => {
      const translate = vi.fn((key: string) => `translated:${key}`)
      const t = translate as unknown as TFunction
      expect(isComputeAuthenticationErrorCode(code)).toBe(true)
      const presentation = computeAuthenticationPresentation(code, 'runtime')
      expect(presentation?.copy(t)).toBe(`translated:${copy}`)
      expect(presentation?.action?.(t)).toBe(`translated:${action}`)
      expect(translate.mock.calls).toEqual([[copy], [action]])
    }
  )

  it.each([
    [
      'credential_required',
      'create',
      'A password must be configured before this Compute Host can connect.'
    ],
    ['credential_unavailable', 'create', 'The saved credential is unavailable on this device.'],
    [
      'secure_storage_unavailable',
      'create',
      'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    ],
    ['authentication_failed', 'create', 'Authentication failed. Verify the username and password.'],
    [
      'host_key_unknown',
      'create',
      'The SSH host key is unknown. Verify it in a terminal before connecting.'
    ],
    [
      'host_key_changed',
      'create',
      'The SSH host key changed. Verify known hosts in a terminal before connecting.'
    ],
    ['host_unreachable', 'create', 'The Compute Host could not be reached.'],
    ['timeout', 'create', 'The Compute Host connection timed out.'],
    ['create_failed', 'create', 'Could not add host.'],
    [
      'unsupported_auth_configuration',
      'create',
      'This SSH authentication configuration is not supported.'
    ],
    [
      'secure_storage_unavailable',
      'password_reset',
      'Secure credential storage is unavailable. Unlock the system keychain and retry.'
    ],
    [
      'authentication_failed',
      'password_reset',
      'Authentication failed. Verify the username and password.'
    ],
    [
      'credential_conflict',
      'password_reset',
      'The Compute Host credentials changed. Start the operation again.'
    ],
    [
      'host_key_unknown',
      'password_reset',
      'The SSH host key is unknown. Verify it in a terminal before connecting.'
    ],
    [
      'host_key_changed',
      'password_reset',
      'The SSH host key changed. Verify known hosts in a terminal before connecting.'
    ],
    ['host_unreachable', 'password_reset', 'The Compute Host could not be reached.'],
    ['timeout', 'password_reset', 'The Compute Host connection timed out.'],
    ['reset_failed', 'password_reset', 'Could not update the saved password.']
  ] as const)(
    'selects inline %s feedback for %s without a runtime navigation action',
    (code, surface, copy) => {
      const translate = vi.fn((key: string) => `translated:${key}`)
      const presentation = computeAuthenticationPresentation(code, surface)
      expect(presentation?.copy(translate as unknown as TFunction)).toBe(`translated:${copy}`)
      expect(presentation?.action).toBeUndefined()
      expect(translate).toHaveBeenCalledExactlyOnceWith(copy)
    }
  )

  it.each([
    ['credential_required', 'password_reset'],
    ['credential_conflict', 'create'],
    ['credential_change_blocked_by_jobs', 'create'],
    ['credential_change_blocked_by_jobs', 'password_reset'],
    ['reset_failed', 'create'],
    ['create_failed', 'password_reset']
  ] as const)('leaves unsupported %s feedback on %s to the caller fallback', (code, surface) => {
    expect(computeAuthenticationPresentation(code, surface)).toBeUndefined()
  })
})

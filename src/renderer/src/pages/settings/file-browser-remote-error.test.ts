import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { encodeRemoteFsError } from '../../../../shared/remote-fs'
import { fileBrowserRemoteError } from './file-browser-remote-error'

const t = ((key: string) => key) as TFunction

describe('fileBrowserRemoteError', () => {
  it('prefers a structured authentication code and presents recovery guidance', () => {
    expect(
      fileBrowserRemoteError(
        {
          message: 'raw IPC message',
          remoteFsError: {
            detail: 'Permission denied',
            remoteKind: 'connection',
            authenticationCode: 'authentication_failed'
          }
        },
        t,
        'fallback'
      )
    ).toEqual({
      detail: 'The saved username or password was rejected. Update it before trying again.',
      remoteKind: 'connection',
      authenticationCode: 'authentication_failed'
    })
  })

  it('decodes serialized remote errors before falling back to the thrown message', () => {
    const serialized = encodeRemoteFsError('Remote operation failed', {
      detail: 'No route to host',
      remoteKind: 'connection',
      authenticationCode: 'host_unreachable'
    })

    expect(fileBrowserRemoteError(new Error(serialized), t, 'fallback')).toEqual({
      detail: 'Check the Host address and network connection, then try again.',
      remoteKind: 'connection',
      authenticationCode: 'host_unreachable'
    })
  })

  it('retains ordinary remote details and supports non-Error fallbacks', () => {
    expect(
      fileBrowserRemoteError(
        {
          message: 'Access denied',
          remoteFsError: { detail: 'Remote directory is private', remoteKind: 'permission' }
        },
        t,
        'fallback'
      )
    ).toEqual({
      detail: 'Remote directory is private',
      remoteKind: 'permission',
      authenticationCode: undefined
    })
    expect(fileBrowserRemoteError(null, t, 'fallback').detail).toBe('fallback')
  })
})

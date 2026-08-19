import type { TFunction } from 'i18next'

import type { ComputeAuthenticationErrorCode } from '../../../../shared/compute'
import { decodeRemoteFsError, type RemoteKind } from '../../../../shared/remote-fs'
import { computeRuntimeRecoveryCopy } from './compute-runtime-recovery'

type FileBrowserRemoteError = Readonly<{
  detail: string
  remoteKind?: RemoteKind
  authenticationCode?: ComputeAuthenticationErrorCode
}>

type ErrorWithRemoteFsPayload = Error & {
  remoteFsError?: {
    detail: string
    remoteKind: RemoteKind
    authenticationCode?: ComputeAuthenticationErrorCode
  }
}

const fileBrowserRemoteError = (
  error: unknown,
  t: TFunction,
  fallback: string
): FileBrowserRemoteError => {
  const candidate =
    typeof error === 'object' && error !== null
      ? (error as Partial<ErrorWithRemoteFsPayload>)
      : undefined
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  const decoded = candidate?.remoteFsError ?? decodeRemoteFsError(message)
  const authenticationCode = decoded?.authenticationCode
  return {
    detail: authenticationCode
      ? computeRuntimeRecoveryCopy(authenticationCode, t)
      : (decoded?.detail ?? (message || fallback)),
    remoteKind: decoded?.remoteKind,
    authenticationCode
  }
}

export { fileBrowserRemoteError }
export type { FileBrowserRemoteError }

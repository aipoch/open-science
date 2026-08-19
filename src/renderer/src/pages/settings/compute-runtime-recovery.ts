import type { TFunction } from 'i18next'

import type { ComputeAuthenticationErrorCode } from '../../../../shared/compute'
import {
  computeAuthenticationPresentation,
  isComputeAuthenticationErrorCode
} from './compute-authentication-presentation'

const computeRuntimeRecoveryCopy = (code: ComputeAuthenticationErrorCode, t: TFunction): string =>
  computeAuthenticationPresentation(code, 'runtime')!.copy(t)

export { computeRuntimeRecoveryCopy }

const computeRuntimeAuthenticationCode = (
  ...values: Array<string | undefined>
): ComputeAuthenticationErrorCode | undefined => {
  for (const value of values) {
    if (isComputeAuthenticationErrorCode(value)) return value
  }
  return undefined
}

const computeRuntimeRecoveryAction = (code: ComputeAuthenticationErrorCode, t: TFunction): string =>
  computeAuthenticationPresentation(code, 'runtime')!.action!(t)

export { computeRuntimeAuthenticationCode, computeRuntimeRecoveryAction }

import type { TFunction } from 'i18next'

import type { ComputeAuthenticationErrorCode } from '../../../../shared/compute'

const computeRuntimeRecoveryCopy = (code: ComputeAuthenticationErrorCode, t: TFunction): string => {
  switch (code) {
    case 'credential_required':
      return t('Configure a password for this Compute Host before trying again.')
    case 'credential_unavailable':
      return t('The saved credential cannot be used on this device. Replace it and test again.')
    case 'secure_storage_unavailable':
      return t('Unlock system credential storage, then test the connection again.')
    case 'authentication_failed':
      return t('The saved username or password was rejected. Update it before trying again.')
    case 'host_key_unknown':
      return t('Verify this Host key in a terminal before connecting from Open Science.')
    case 'host_key_changed':
      return t('Verify the changed Host key in known hosts before connecting again.')
    case 'host_unreachable':
      return t('Check the Host address and network connection, then try again.')
    case 'timeout':
      return t('The connection timed out. Check the network or Host load, then try again.')
    case 'unsupported_auth_configuration':
      return t('This authentication setup is not supported. Review the Host configuration.')
    case 'credential_conflict':
      return t('Credentials changed in another window. Reload this Host before continuing.')
    case 'credential_change_blocked_by_jobs':
      return t(
        'Authentication change blocked. Finish or safely delete active and unharvested Compute Jobs first.'
      )
    case 'create_failed':
      return t('The Compute Host could not be added. Review its configuration and try again.')
    case 'reset_failed':
      return t('Could not update the saved password.')
  }
}

export { computeRuntimeRecoveryCopy }

const computeRuntimeAuthenticationCode = (
  ...values: Array<string | undefined>
): ComputeAuthenticationErrorCode | undefined => {
  for (const value of values) {
    switch (value) {
      case 'credential_required':
      case 'credential_unavailable':
      case 'secure_storage_unavailable':
      case 'authentication_failed':
      case 'credential_conflict':
      case 'credential_change_blocked_by_jobs':
      case 'host_key_unknown':
      case 'host_key_changed':
      case 'host_unreachable':
      case 'timeout':
      case 'create_failed':
      case 'reset_failed':
      case 'unsupported_auth_configuration':
        return value
    }
  }
  return undefined
}

const computeRuntimeRecoveryAction = (
  code: ComputeAuthenticationErrorCode,
  t: TFunction
): string => {
  switch (code) {
    case 'credential_required':
    case 'credential_unavailable':
    case 'secure_storage_unavailable':
    case 'authentication_failed':
    case 'credential_conflict':
    case 'credential_change_blocked_by_jobs':
    case 'reset_failed':
      return t('Manage credentials')
    case 'host_unreachable':
    case 'timeout':
      return t('Review connection settings')
    case 'host_key_unknown':
    case 'host_key_changed':
    case 'create_failed':
    case 'unsupported_auth_configuration':
      return t('Review Host settings')
  }
}

export { computeRuntimeAuthenticationCode, computeRuntimeRecoveryAction }

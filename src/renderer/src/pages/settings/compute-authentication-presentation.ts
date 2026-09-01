import type { TFunction } from 'i18next'

import type { ComputeAuthenticationErrorCode } from '../../../../shared/compute'

type ComputeAuthenticationPresentationSurface = 'runtime' | 'create' | 'password_reset'

type ComputeAuthenticationPresentation = Readonly<{
  copy: (t: TFunction) => string
  action?: (t: TFunction) => string
}>

type ComputeAuthenticationPresentationEntry = Readonly<{
  runtime: ComputeAuthenticationPresentation
  create?: ComputeAuthenticationPresentation
  password_reset?: ComputeAuthenticationPresentation
}>

const runtime = (
  copy: (t: TFunction) => string,
  action: (t: TFunction) => string
): ComputeAuthenticationPresentation => ({ copy, action })

const COMPUTE_AUTHENTICATION_PRESENTATIONS = {
  credential_required: {
    runtime: runtime(
      (t) => t('Configure a password for this Compute Host before trying again.'),
      (t) => t('Manage credentials')
    ),
    create: {
      copy: (t) => t('A password must be configured before this Compute Host can connect.')
    }
  },
  credential_unavailable: {
    runtime: runtime(
      (t) => t('The saved credential cannot be used on this device. Replace it and test again.'),
      (t) => t('Manage credentials')
    ),
    create: { copy: (t) => t('The saved credential is unavailable on this device.') }
  },
  secure_storage_unavailable: {
    runtime: runtime(
      (t) => t('Unlock system credential storage, then test the connection again.'),
      (t) => t('Manage credentials')
    ),
    create: {
      copy: (t) =>
        t('Secure credential storage is unavailable. Unlock the system keychain and retry.')
    },
    password_reset: {
      copy: (t) =>
        t('Secure credential storage is unavailable. Unlock the system keychain and retry.')
    }
  },
  authentication_failed: {
    runtime: runtime(
      (t) => t('The saved username or password was rejected. Update it before trying again.'),
      (t) => t('Manage credentials')
    ),
    create: { copy: (t) => t('Authentication failed. Verify the username and password.') },
    password_reset: {
      copy: (t) => t('Authentication failed. Verify the username and password.')
    }
  },
  credential_conflict: {
    runtime: runtime(
      (t) => t('Credentials changed in another window. Reload this Host before continuing.'),
      (t) => t('Manage credentials')
    ),
    password_reset: {
      copy: (t) => t('The Compute Host credentials changed. Start the operation again.')
    }
  },
  credential_change_blocked_by_jobs: {
    runtime: runtime(
      (t) =>
        t(
          'Authentication change blocked. Finish or safely delete active and unharvested Compute Jobs first.'
        ),
      (t) => t('Manage credentials')
    )
  },
  host_key_unknown: {
    runtime: runtime(
      (t) => t('Verify this Host key in a terminal before connecting from Open Science.'),
      (t) => t('Review Host settings')
    ),
    create: {
      copy: (t) => t('The SSH host key is unknown. Verify it in a terminal before connecting.')
    },
    password_reset: {
      copy: (t) => t('The SSH host key is unknown. Verify it in a terminal before connecting.')
    }
  },
  host_key_changed: {
    runtime: runtime(
      (t) => t('Verify the changed Host key in known hosts before connecting again.'),
      (t) => t('Review Host settings')
    ),
    create: {
      copy: (t) =>
        t('The SSH host key changed. Verify known hosts in a terminal before connecting.')
    },
    password_reset: {
      copy: (t) =>
        t('The SSH host key changed. Verify known hosts in a terminal before connecting.')
    }
  },
  host_unreachable: {
    runtime: runtime(
      (t) => t('Check the Host address and network connection, then try again.'),
      (t) => t('Review connection settings')
    ),
    create: { copy: (t) => t('The Compute Host could not be reached.') },
    password_reset: { copy: (t) => t('The Compute Host could not be reached.') }
  },
  timeout: {
    runtime: runtime(
      (t) => t('The connection timed out. Check the network or Host load, then try again.'),
      (t) => t('Review connection settings')
    ),
    create: { copy: (t) => t('The Compute Host connection timed out.') },
    password_reset: { copy: (t) => t('The Compute Host connection timed out.') }
  },
  create_failed: {
    runtime: runtime(
      (t) => t('The Compute Host could not be added. Review its configuration and try again.'),
      (t) => t('Review Host settings')
    ),
    create: { copy: (t) => t('Could not add host.') }
  },
  reset_failed: {
    runtime: runtime(
      (t) => t('Could not update the saved password.'),
      (t) => t('Manage credentials')
    ),
    password_reset: { copy: (t) => t('Could not update the saved password.') }
  },
  unsupported_auth_configuration: {
    runtime: runtime(
      (t) => t('This authentication setup is not supported. Review the Host configuration.'),
      (t) => t('Review Host settings')
    ),
    create: { copy: (t) => t('This SSH authentication configuration is not supported.') }
  }
} as const satisfies Record<ComputeAuthenticationErrorCode, ComputeAuthenticationPresentationEntry>

const computeAuthenticationPresentation = (
  code: ComputeAuthenticationErrorCode,
  surface: ComputeAuthenticationPresentationSurface
): ComputeAuthenticationPresentation | undefined => {
  const presentations: ComputeAuthenticationPresentationEntry =
    COMPUTE_AUTHENTICATION_PRESENTATIONS[code]
  return presentations[surface]
}

const isComputeAuthenticationErrorCode = (
  value: unknown
): value is ComputeAuthenticationErrorCode =>
  typeof value === 'string' && Object.hasOwn(COMPUTE_AUTHENTICATION_PRESENTATIONS, value)

export { computeAuthenticationPresentation, isComputeAuthenticationErrorCode }
export type { ComputeAuthenticationPresentationSurface }

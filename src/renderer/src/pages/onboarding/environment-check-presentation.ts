import type { TFunction } from 'i18next'

import type { EnvironmentCheckItem } from '../../../../shared/settings'

const localizedLabel = (check: EnvironmentCheckItem, t: TFunction): string => {
  switch (check.id) {
    case 'system':
      return t('System compatibility')
    case 'storage':
      return t('App storage permission')
    case 'secure-storage':
      return t('Secure credential storage')
    case 'install-network':
      return t('Installation network')
    default:
      return check.label
  }
}

const localizeHostEnvironmentCheck = (
  check: EnvironmentCheckItem,
  t: TFunction
): EnvironmentCheckItem => {
  switch (check.presentation?.kind) {
    case 'system-supported':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('{{platform}} {{architecture}} is supported.', {
          platform: check.presentation.platform,
          architecture: check.presentation.architecture
        }),
        detail: t(
          'Automatic setup uses an app-managed runtime and does not require administrator access.'
        )
      }
    case 'system-baseline-supported':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t(
          '{{platform}} {{architecture}} is supported — the baseline build will be installed.',
          {
            platform: check.presentation.platform,
            architecture: check.presentation.architecture
          }
        ),
        detail: t(
          'This CPU lacks AVX2, so automatic setup installs the app-managed baseline runtime. No administrator access is required.'
        )
      }
    case 'system-detected-runtime':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('{{platform}} {{architecture}} can use the detected {{runtime}} runtime.', {
          platform: check.presentation.platform,
          architecture: check.presentation.architecture,
          runtime: check.presentation.runtime
        })
      }
    case 'system-no-installer':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('{{platform}} {{architecture}} has no automatic installer package.', {
          platform: check.presentation.platform,
          architecture: check.presentation.architecture
        })
      }
    case 'storage-writable':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('Open Science can write to its private data folder.')
      }
    case 'storage-unwritable':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('Open Science cannot write to its private data folder.')
      }
    case 'secure-storage-available':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('The operating-system credential vault is available.')
      }
    case 'secure-storage-unavailable':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('The operating-system credential vault is unavailable.'),
        detail: t(
          'Unlock or authorize the system keychain before saving API keys. Keyless runtimes can continue setup.'
        )
      }
    case 'install-network-runtime-present':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('No download is needed because {{runtime}} is already installed.', {
          runtime: check.presentation.runtime
        })
      }
    case 'install-network-registry-available':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('{{registry}} is the fastest reachable source.', {
          registry:
            check.presentation.registry === 'npmjs'
              ? t('official npm registry')
              : t('China-friendly npmmirror')
        }),
        detail: t(
          'Measured {{latencyMs}} ms. The other trusted source remains available as an automatic fallback.',
          { latencyMs: check.presentation.latencyMs }
        )
      }
    case 'install-network-unreachable':
      return {
        ...check,
        label: localizedLabel(check, t),
        summary: t('Neither the official registry nor the China-friendly mirror is reachable.'),
        detail: t('Check the network, proxy, VPN, or firewall, then run the check again.')
      }
    default:
      return check
  }
}

export { localizeHostEnvironmentCheck }

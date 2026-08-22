import type { TFunction } from 'i18next'

export const localizeConnectorError = (message: string, t: TFunction): string =>
  message === 'Authorization server URL is required for a pre-registered client.'
    ? t('Authorization server URL is required for a pre-registered client.')
    : message === 'Client metadata URL cannot be combined with a pre-registered client.'
      ? t('Client metadata URL cannot be combined with a pre-registered client.')
      : message === 'Client ID is required when a client secret is configured.'
        ? t('Client ID is required when a client secret is configured.')
        : message === 'OAuth redirect URI must be a valid URL.'
          ? t('OAuth redirect URI must be a valid URL.')
          : message === 'OAuth redirect URI must be an http://127.0.0.1 loopback URL.'
            ? t('OAuth redirect URI must be an http://127.0.0.1 loopback URL.')
            : message === 'OAuth redirect URI requires a pre-registered client ID.'
              ? t('OAuth redirect URI requires a pre-registered client ID.')
              : message ===
                  'Secure credential storage is unavailable. Unlock the system keychain and retry.'
                ? t(
                    'Secure credential storage is unavailable. Unlock the system keychain and retry.'
                  )
                : message

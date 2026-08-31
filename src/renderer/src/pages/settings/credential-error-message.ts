import type { TFunction } from 'i18next'

import { errorDetail } from '@/lib/error-detail'

const TRANSLATABLE_MESSAGES = new Set([
  'Authorization server URL is required for a pre-registered client.',
  'Client metadata URL cannot be combined with a pre-registered client.',
  'Client ID is required when a client secret is configured.',
  'OAuth redirect URI must be a valid URL.',
  'OAuth redirect URI must be an http://127.0.0.1 loopback URL.',
  'OAuth redirect URI requires a pre-registered client ID.',
  'Remote MCP server URL must use HTTPS or loopback HTTP.',
  'Secure credential storage is unavailable. Unlock the system keychain and retry.'
])

export const localizeCredentialError = (error: unknown, t: TFunction, fallback: string): string => {
  const detail = errorDetail(error)
  if (!detail) return t(fallback)
  if (/^Credential is used by:/u.test(detail)) {
    return t('Remove this credential from its Connectors first.')
  }
  if (
    detail === 'credential_unavailable' ||
    detail === 'Device credentials are unavailable' ||
    /^Unknown (?:OAuth )?credential:/u.test(detail)
  ) {
    return t('The saved credential is unavailable on this device.')
  }
  return TRANSLATABLE_MESSAGES.has(detail) ? t(detail) : t(fallback)
}

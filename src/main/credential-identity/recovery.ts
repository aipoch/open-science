import { resolveLocale } from '../../shared/locale'
import { createNativeI18n } from '../locale/main-process-messages'
import type { CredentialIdentityError } from './selection'

export const credentialRecoveryMessage = (
  error: CredentialIdentityError,
  systemLanguages: readonly string[]
): string => {
  const i18n = createNativeI18n(resolveLocale('system', systemLanguages))
  const translate = i18n.t.bind(i18n)
  const title = translate('Credential storage needs recovery')
  const description = error.reason.startsWith('linux-')
    ? translate(
        'Linux OS credentials require an available Secret Service backend and /usr/bin/busctl. Unlock the original default keyring and restart. For an unsupported backend, use a compatible application version without changing the backend or profile.'
      )
    : error.reason.includes('unsupported')
      ? translate(
          'Silent credential identity checks are not supported by this system credential backend. Startup has stopped to preserve existing encrypted data.'
        )
      : translate(
          'Open-Science could not safely access existing encrypted data. Unlock the system credential store or restore the original key and profile, then restart. Existing credentials have not been replaced.'
        )
  const code = error.probe?.reason ? `${error.reason} / ${error.probe.reason}` : error.reason
  return `${title}\n\n${description}\n\nCREDENTIAL_IDENTITY: ${code}`
}

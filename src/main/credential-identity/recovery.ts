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
  const description = error.reason.includes('unsupported')
    ? translate(
        'Silent credential identity checks are not supported by this system credential backend. Startup has stopped to preserve existing encrypted data.'
      )
    : translate(
        'Open-Science could not safely access existing encrypted data. Unlock the system credential store or restore the original key and profile, then restart. Existing credentials have not been replaced.'
      )
  return `${title}\n\n${description}\n\nCREDENTIAL_IDENTITY: ${error.reason}`
}

import { resolveLocale } from '../../shared/locale'
import { createNativeI18n, type NativeTranslator } from '../locale/main-process-messages'
import type { CredentialIdentityError } from './selection'
import type { CredentialDiagnostic } from './diagnostic'

const diagnosticMessage = (
  diagnostic: CredentialDiagnostic,
  translate: NativeTranslator
): string => {
  switch (diagnostic.code) {
    case 'profile-read-failed':
      return diagnostic.systemCode === 'EBUSY'
        ? translate('Local State is in use by another process.')
        : translate('The Local State configuration file could not be read.')
    case 'profile-too-large':
    case 'profile-invalid-json':
    case 'profile-invalid-shape':
      return translate('The Local State configuration file is invalid.')
    case 'profile-key-missing':
      return translate('The encryption key is missing from Local State.')
    case 'profile-key-invalid':
      return translate('The encryption key in Local State is invalid.')
    case 'profile-changed':
      return translate('Local State changed during credential validation.')
    case 'validator-start-failed':
      return translate('The Windows credential validator could not start.')
    case 'validator-timeout':
      return translate('The Windows credential validator timed out.')
    case 'validator-failed':
    case 'validator-invalid-response':
    case 'validator-input-failed':
      return translate('The Windows credential validator failed.')
    case 'validator-unsupported':
      return translate('Windows credential validation is unavailable on this system.')
    case 'dpapi-unprotect-failed':
      return translate('Windows could not decrypt the existing credential key.')
  }
}

export const credentialRecoveryMessage = (
  error: CredentialIdentityError,
  systemLanguages: readonly string[]
): string => {
  const i18n = createNativeI18n(resolveLocale('system', systemLanguages))
  const translate = i18n.t.bind(i18n)
  const title = translate('Credential storage needs recovery')
  const description =
    error.reason === 'unsupported-ciphertext-version'
      ? translate(
          'This encrypted data format is not supported by this app version. Use a compatible app version or restore the original profile. Existing credentials have not been replaced.'
        )
      : error.reason.startsWith('linux-')
        ? translate(
            'Linux OS credentials require the original selected Secret Service or KWallet backend and /usr/bin/busctl. Unlock the original default keyring or wallet and restart. Do not change the password-store backend or profile to bypass this check.'
          )
        : error.reason.includes('unsupported')
          ? translate(
              'Silent credential identity checks are not supported by this system credential backend. Startup has stopped to preserve existing encrypted data.'
            )
          : translate(
              'Open-Science could not safely access existing encrypted data. Unlock the system credential store or restore the original key and profile, then restart. Existing credentials have not been replaced.'
            )
  const code = error.probe?.reason ? `${error.reason} / ${error.probe.reason}` : error.reason
  const diagnostic = error.diagnostic
  const details = diagnostic
    ? [
        diagnosticMessage(diagnostic, translate),
        `CREDENTIAL_DETAIL: ${diagnostic.code}`,
        ...(diagnostic.systemCode !== undefined ? [`SYSTEM_ERROR: ${diagnostic.systemCode}`] : []),
        ...(diagnostic.osStatus !== undefined ? [`WINDOWS_ERROR: ${diagnostic.osStatus}`] : []),
        ...(diagnostic.exitCode !== undefined ? [`HELPER_EXIT: ${diagnostic.exitCode}`] : [])
      ].join('\n')
    : undefined
  return `${title}\n\n${description}\n\nCREDENTIAL_IDENTITY: ${code}${details ? `\n\n${details}` : ''}`
}

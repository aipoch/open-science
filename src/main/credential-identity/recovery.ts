import { resolveLocale } from '../../shared/locale'
import { createNativeI18n, type NativeTranslator } from '../locale/main-process-messages'
import type { CredentialIdentityError } from './selection'
import type { CredentialDiagnostic, InventoryDiagnostic } from './diagnostic'

const inventoryMessage = (diagnostic: InventoryDiagnostic, translate: NativeTranslator): string => {
  const sources = {
    configuration: translate('Configuration folder'),
    settings: translate('Application settings'),
    credentials: translate('Credential configuration'),
    'application-database': translate('Application database'),
    'browser-profile': translate('Browser profile'),
    cookies: translate('Browser cookies')
  }
  const stages = {
    'read-files': translate('Reading files'),
    'parse-document': translate('Parsing configuration'),
    'check-journal': translate('Checking database journals'),
    'copy-snapshot': translate('Preparing a temporary database copy'),
    'read-database': translate('Reading database contents'),
    'cleanup-snapshot': translate('Cleaning up database inspection resources'),
    'inspect-profile': translate('Inspecting browser profiles')
  }
  const reasons = {
    'operation-failed':
      diagnostic.systemCode === 'EACCES' || diagnostic.systemCode === 'EPERM'
        ? translate('Access was denied by the operating system.')
        : diagnostic.systemCode === 'EBUSY'
          ? translate('The file is in use by another process.')
          : diagnostic.stage === 'read-database'
            ? translate('The database could not be read.')
            : translate('The operation failed; the exact cause is unknown.'),
    'invalid-json': translate('The configuration is not valid JSON.'),
    'invalid-document': translate('The credential configuration format is invalid.'),
    'pending-document': translate('An unfinished configuration write needs recovery.'),
    'too-large': translate('The file is too large to inspect safely.'),
    'invalid-ciphertext': translate('An encrypted data entry has an invalid format.'),
    'unsupported-file': translate(
      'A required file or profile is not a supported regular file or directory.'
    ),
    'source-changed': translate('The source files changed during inspection.'),
    'journal-incomplete': translate('The rollback journal header is incomplete.'),
    'journal-invalid': translate('The rollback journal format cannot be inspected safely.'),
    'super-journal': translate(
      'A multi-database transaction journal requires recovery before inspection.'
    ),
    'conflicting-journals': translate('Conflicting database recovery journals were found.'),
    'sqlite-unavailable': translate('SQLite inspection is unavailable in this runtime.')
  }
  return [
    translate('Affected data: {{source}}', { source: sources[diagnostic.source] }),
    translate('Stage: {{stage}}', { stage: stages[diagnostic.stage] }),
    translate('Failure reason: {{reason}}', { reason: reasons[diagnostic.reason] })
  ].join('\n')
}

const diagnosticMessage = (
  diagnostic: CredentialDiagnostic,
  translate: NativeTranslator
): string => {
  switch (diagnostic.code) {
    case 'secret-timeout':
      return translate(
        'System credential authorization timed out. Retry startup and respond to the system authorization prompt.'
      )
    case 'secret-start-failed':
      return translate(
        'The system credential helper could not complete its operation. Check the diagnostic code and retry startup.'
      )
    case 'secret-exit-failed':
    case 'secret-signalled':
    case 'secret-empty-response':
      return translate(
        'The system credential helper failed. The exact authorization or key status is unknown.'
      )
    case 'inventory-failed':
      return inventoryMessage(diagnostic, translate)
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
  const inventoryFailure = error.reason === 'ciphertext-inventory-unavailable'
  const secretFailure = error.reason === 'native-secret-operation-failed'
  const title = secretFailure
    ? translate('System credential access failed')
    : inventoryFailure
      ? translate('Startup data inspection failed')
      : translate('Credential storage needs recovery')
  const description = secretFailure
    ? translate(
        'Startup stopped while accessing system credentials. Existing credentials and profile data have been preserved. Retry startup after resolving the authorization problem.'
      )
    : inventoryFailure
      ? translate(
          'Startup has stopped. This check has not modified the original data. Share the diagnostic details below with support; this error alone does not establish that an encryption key is missing.'
        )
      : error.reason === 'unsupported-ciphertext-version'
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
        ...('osStatus' in diagnostic && diagnostic.osStatus !== undefined
          ? [`WINDOWS_ERROR: ${diagnostic.osStatus}`]
          : []),
        ...('signal' in diagnostic && diagnostic.signal
          ? [`HELPER_SIGNAL: ${diagnostic.signal}`]
          : []),
        ...('exitCode' in diagnostic && diagnostic.exitCode !== undefined
          ? [`HELPER_EXIT: ${diagnostic.exitCode}`]
          : [])
      ].join('\n')
    : inventoryFailure
      ? translate('The failing data source and exact cause are unknown.')
      : undefined
  return `${title}\n\n${description}\n\nCREDENTIAL_IDENTITY: ${code}${details ? `\n\n${details}` : ''}`
}

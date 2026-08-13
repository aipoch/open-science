// Which security-promise copy the API-key field shows. The English text doubles as the catalog key,
// so this stays a pure, locale-independent decision about the fail-closed safeStorage boundary and
// ProviderForm resolves the result through t(). The `as const` keeps the literal union rather than
// widening to `string`: t() no longer key-checks its argument, so the union is what makes an edit
// here and a stale copy of the same sentence elsewhere fail to compile.
type ApiKeySecurityCopyKeys =
  | {
      readonly title: 'Your key stays private.'
      readonly description: 'It is stored only on this device and never uploaded to Open Science. Your OS secure storage protects it, and it is sent only to the selected provider when you make a request.'
    }
  | {
      readonly title: 'Secure storage is unavailable.'
      readonly description: 'Open Science will not save API keys until the operating-system credential vault is available. Unlock or authorize the system keychain, then retry.'
    }

const getApiKeySecurityCopyKeys = (encryptionAvailable: boolean): ApiKeySecurityCopyKeys =>
  encryptionAvailable
    ? ({
        title: 'Your key stays private.',
        description:
          'It is stored only on this device and never uploaded to Open Science. Your OS secure storage protects it, and it is sent only to the selected provider when you make a request.'
      } as const)
    : ({
        title: 'Secure storage is unavailable.',
        description:
          'Open Science will not save API keys until the operating-system credential vault is available. Unlock or authorize the system keychain, then retry.'
      } as const)

export { getApiKeySecurityCopyKeys }

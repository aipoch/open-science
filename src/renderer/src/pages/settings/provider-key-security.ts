type ApiKeySecurityCopy = {
  title: string
  description: string
}

// Keeps the security promise aligned with the fail-closed safeStorage boundary.
const getApiKeySecurityCopy = (encryptionAvailable: boolean): ApiKeySecurityCopy =>
  encryptionAvailable
    ? {
        title: 'Your key stays private.',
        description:
          'It is stored only on this device and never uploaded to Open Science. Your OS secure storage protects it, and it is sent only to the selected provider when you make a request.'
      }
    : {
        title: 'Secure storage is unavailable.',
        description:
          'Open Science will not save API keys until the operating-system credential vault is available. Unlock or authorize the system keychain, then retry.'
      }

export { getApiKeySecurityCopy }

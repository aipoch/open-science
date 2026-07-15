type ApiKeySecurityCopy = {
  title: string
  description: string
}

// Keeps the security promise aligned with the actual safeStorage and reduced-protection paths.
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
          'It is stored only on this device and never uploaded to Open Science. OS secure storage is unavailable, so it has reduced local protection and is sent only to the selected provider when you make a request.'
      }

export { getApiKeySecurityCopy }

export const executablePath: string
export const validatorExecutablePath: string

export type CredentialIdentityProbeResult = {
  schemaVersion: 1
  platform: 'darwin' | 'win32' | 'linux'
  identity: string
  status: 'exists' | 'not-found' | 'access-blocked' | 'error' | 'unsupported'
  reason: string
  osStatus: number
  account?: string
}

export type CredentialKeyValidationResult = {
  schemaVersion: 1
  platform: 'darwin' | 'win32' | 'linux'
  status: 'valid' | 'access-blocked' | 'error' | 'unsupported'
  reason: string
  errorCode: number
}

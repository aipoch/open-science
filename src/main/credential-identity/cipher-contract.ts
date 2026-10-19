export interface SecureStorageCipher {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  // Startup-only validation of Chromium binary cookie values.
  validateEncryptedCookie?(
    value: Buffer,
    context: { hostKey: string; databaseVersion: number }
  ): void
}

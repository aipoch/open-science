// Bounded resource envelope for the optional Lab enterprise provider. Every outbound call has its
// own deadline so a misconfigured or unreachable Lab server can never stall the app, and every
// response is size-limited before it is parsed into memory.

export const LAB_RESOURCE_LIMITS = Object.freeze({
  // Network deadlines. Bootstrap, login-attempt registration, token exchange and refresh are all
  // short: the Lab API is an enterprise gateway on the customer's own network.
  loginAttemptTimeoutMs: 8_000,
  tokenTimeoutMs: 8_000,
  bootstrapTimeoutMs: 8_000,
  usageTimeoutMs: 8_000,
  logoutTimeoutMs: 5_000,
  // Package upload and server-side validation/object storage transfer can legitimately take minutes.
  caseUploadTimeoutMs: 20 * 60_000,
  // Registration window from POST /api/auth/login-attempts. The server expires it after five
  // minutes; the client must not outlive it either.
  loginWindowMs: 5 * 60_000,
  // Refresh proactively when the access token has less than this available.
  accessRefreshLeadMs: 60_000,
  // Response caps.
  maxResponseBytes: 1024 * 1024,
  maxModels: 500,
  maxModelIdCharacters: 200,
  maxModelNameCharacters: 200,
  serverUrlCharacters: 2_048,
  installationIdCharacters: 128,
  // Persisted credential document cap (contains one encrypted JSON payload).
  documentBytes: 1024 * 1024
})

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

export const assertLabModelCatalog = (
  models: readonly Readonly<{ id: string; name?: string }>[]
): void => {
  if (models.length > LAB_RESOURCE_LIMITS.maxModels) {
    throw new Error(`Lab returned more than ${LAB_RESOURCE_LIMITS.maxModels} models.`)
  }
  for (const model of models) {
    if (!model.id.trim()) throw new Error('Lab returned a model without an id.')
    if (utf8Bytes(model.id) > LAB_RESOURCE_LIMITS.maxModelIdCharacters) {
      throw new Error('Lab returned a model id that is too long.')
    }
    if (model.name && utf8Bytes(model.name) > LAB_RESOURCE_LIMITS.maxModelNameCharacters) {
      throw new Error('Lab returned a model name that is too long.')
    }
  }
}

export const assertLabServerUrlLength = (serverUrl: string): void => {
  if (utf8Bytes(serverUrl) > LAB_RESOURCE_LIMITS.serverUrlCharacters) {
    throw new Error('The Lab server address is too long.')
  }
}

const SETTINGS_RESOURCE_LIMITS = Object.freeze({
  credentialBytes: 16 * 1024,
  documentBytes: 128 * 1024 * 1024
})

const characterCount = (value: string): number => Array.from(value).length

const assertCharacterLimit = (value: string | undefined, limit: number, label: string): void => {
  if (value !== undefined && characterCount(value) > limit) {
    throw new Error(`${label} must not exceed ${limit} characters.`)
  }
}

export { SETTINGS_RESOURCE_LIMITS, assertCharacterLimit, characterCount }

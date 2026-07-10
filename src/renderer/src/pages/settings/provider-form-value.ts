import type { ProviderType } from '../../../../shared/settings'

// Editable value for the provider form, kept in its own module so the component file only exports a
// component (satisfying react-refresh) while the wizard and settings page share this shape/factory.
export type ProviderFormValue = {
  type: ProviderType
  name: string
  baseUrl: string
  model: string
  // Plaintext only while the user is typing a new key; empty means "keep the stored key".
  key: string
}

// Builds an empty form value, defaulting to a custom provider (the common first-run case).
export const createEmptyProviderFormValue = (
  overrides: Partial<ProviderFormValue> = {}
): ProviderFormValue => ({
  type: 'custom',
  name: '',
  baseUrl: '',
  model: '',
  key: '',
  ...overrides
})

// Per-field validation errors for a custom provider draft. claude-default has no required fields.
export type ProviderFormErrors = {
  baseUrl?: string
  key?: string
  model?: string
}

// Computes required-field errors for a custom draft. On edit, an already-stored key satisfies the key
// requirement, so the user can leave the key blank to keep it.
export const getProviderFormErrors = (
  value: ProviderFormValue,
  options: { hasStoredKey?: boolean } = {}
): ProviderFormErrors => {
  if (value.type !== 'custom') return {}

  const errors: ProviderFormErrors = {}

  if (!value.baseUrl.trim()) errors.baseUrl = 'Base URL is required.'
  if (!value.model.trim()) errors.model = 'Model is required.'
  if (!value.key.trim() && !options.hasStoredKey) errors.key = 'API key is required.'

  return errors
}

// True when a draft has at least one required-field error (blocks save/test).
export const hasProviderFormErrors = (errors: ProviderFormErrors): boolean =>
  Object.keys(errors).length > 0

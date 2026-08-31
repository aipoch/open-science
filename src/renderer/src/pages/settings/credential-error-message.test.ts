import type { TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import { localizeCredentialError } from './credential-error-message'

const translated = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction

describe('localizeCredentialError', () => {
  it('localizes known credential errors and hides unknown backend details', () => {
    expect(
      localizeCredentialError(new Error('Credential is used by: Connector'), translated, 'fallback')
    ).toBe('translated:Remove this credential from its Connectors first.')
    expect(
      localizeCredentialError(new Error('private backend detail'), translated, 'fallback')
    ).toBe('translated:fallback')
  })
})

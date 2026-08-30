import type { TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import { localizeConnectorError } from './connector-error-message'

describe('localizeConnectorError', () => {
  it('localizes the aggregate credential argument diagnostic', () => {
    const t = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction

    expect(localizeConnectorError('args appears to contain a credential.', t)).toBe(
      'translated:args appears to contain a credential.'
    )
    expect(t).toHaveBeenCalledWith('args appears to contain a credential.')
  })
})

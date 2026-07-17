import { describe, expect, it } from 'vitest'
import { createEmptySettings } from './types'

describe('StoredSettings.dataRoot', () => {
  it('defaults to undefined on empty settings', () => {
    expect(createEmptySettings().dataRoot).toBeUndefined()
  })
})

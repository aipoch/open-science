import { describe, it, expect } from 'vitest'
import { ncbiEtiquette } from './engine'

describe('ncbiEtiquette', () => {
  it('returns empty string when no credentials', () => {
    expect(ncbiEtiquette({})).toBe('')
  })
  it('url-encodes email and appends api key', () => {
    expect(ncbiEtiquette({ ncbiEmail: 'a b@x.org', ncbiApiKey: 'KEY' })).toBe(
      '&email=a%20b%40x.org&api_key=KEY'
    )
  })
})

import { createHash, createPublicKey } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { OFFICIAL_MARKETPLACE_SOURCE } from './official-source'

describe('official Specialist Marketplace source', () => {
  it('pins the production repository, CDN fallback order, and Ed25519 key', () => {
    expect(OFFICIAL_MARKETPLACE_SOURCE).toEqual({
      id: 'openscience-official',
      name: 'OpenScience Specialist Marketplace',
      repositoryUrl: 'https://github.com/aipoch/openscience-specialist-marketplace',
      ref: 'published',
      metadataBaseUrls: [
        'https://statics.aipoch.com/open-science/specialist-marketplace/v1/',
        'https://raw.githubusercontent.com/aipoch/openscience-specialist-marketplace/published/'
      ],
      artifactBaseUrls: ['https://statics.aipoch.com/open-science/specialist-marketplace/v1/'],
      trustedKeys: {
        'openscience-marketplace-2026-08':
          'MCowBQYDK2VwAyEAKOudx9NtRJakg0xAQFzVdz/5+T/X/xG0F6pCwUu8SQk='
      }
    })

    const publicKey = Object.values(OFFICIAL_MARKETPLACE_SOURCE.trustedKeys)[0]
    expect(
      createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
        .asymmetricKeyType
    ).toBe('ed25519')
    expect(createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')).toBe(
      '9bdba1af0966b5239366c556f504ab3207f0be71bc4501e089465a863c63c4c3'
    )
  })
})

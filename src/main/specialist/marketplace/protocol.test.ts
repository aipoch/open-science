import { generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  marketplaceKeyFingerprint,
  parseMarketplaceRoot,
  parseMarketplaceSignature,
  verifyMarketplaceRoot
} from './protocol'

const encoder = new TextEncoder()

const rootBytes = encoder.encode(
  JSON.stringify({
    schema_version: 1,
    revision: '2026-08-17.1',
    marketplace: { id: 'example-marketplace', name: 'Example Marketplace' },
    specialists: [
      {
        id: 'example-specialist',
        display_name: 'Example Specialist',
        summary: 'An example.',
        author: 'Example Author',
        publisher: { id: 'example', name: 'Example' },
        latest: {
          version: '1.0.0',
          release: { path: 'releases/example-specialist/1.0.0.json', sha256: 'a'.repeat(64) }
        }
      }
    ]
  })
)

describe('Specialist Marketplace protocol', () => {
  it('verifies exact root bytes with the declared Ed25519 SPKI key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const signatureBytes = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        algorithm: 'ed25519',
        key_id: 'example-2026-01',
        public_key: publicKeyBase64,
        signature: sign(null, rootBytes, privateKey).toString('base64')
      })
    )

    const root = parseMarketplaceRoot(rootBytes)
    const signature = parseMarketplaceSignature(signatureBytes)

    expect(root.specialists[0]?.id).toBe('example-specialist')
    expect(root.specialists[0]?.author).toBe('Example Author')
    expect(marketplaceKeyFingerprint(publicKeyBase64)).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyMarketplaceRoot(rootBytes, signature)).toBe(true)
    expect(
      verifyMarketplaceRoot(encoder.encode(`${new TextDecoder().decode(rootBytes)}\n`), signature)
    ).toBe(false)
  })

  it('rejects unknown fields and unsafe release paths', () => {
    const parsed = JSON.parse(new TextDecoder().decode(rootBytes))
    parsed.unexpected = true
    expect(() => parseMarketplaceRoot(encoder.encode(JSON.stringify(parsed)))).toThrow()

    delete parsed.unexpected
    parsed.specialists[0].latest.release.path = '../outside.json'
    expect(() => parseMarketplaceRoot(encoder.encode(JSON.stringify(parsed)))).toThrow()
  })

  it('accepts the full Specialist package SemVer grammar', () => {
    const parsed = JSON.parse(new TextDecoder().decode(rootBytes))
    parsed.specialists[0].latest.version = '1.2.3-rc.1+build.7'

    expect(
      parseMarketplaceRoot(encoder.encode(JSON.stringify(parsed))).specialists[0]?.latest.version
    ).toBe('1.2.3-rc.1+build.7')
  })

  it('accepts a missing author and rejects a blank author', () => {
    const parsed = JSON.parse(new TextDecoder().decode(rootBytes))
    delete parsed.specialists[0].author
    expect(
      parseMarketplaceRoot(encoder.encode(JSON.stringify(parsed))).specialists[0]?.author
    ).toBeUndefined()

    parsed.specialists[0].author = '   '
    expect(() => parseMarketplaceRoot(encoder.encode(JSON.stringify(parsed)))).toThrow()
  })
})

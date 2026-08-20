import { describe, expect, it } from 'vitest'

import { decodeVersionedJson } from './versioned-json-decoder'

type ExampleDocument = Readonly<{ schemaVersion: number; name: string }>

const decodeExample = (value: unknown): ExampleDocument | undefined => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    !('name' in value) ||
    typeof value.schemaVersion !== 'number' ||
    typeof value.name !== 'string'
  ) {
    return undefined
  }
  return { schemaVersion: value.schemaVersion, name: value.name }
}

describe('versioned JSON decoder', () => {
  it('returns valid for a current-version document that passes domain decoding', () => {
    expect(
      decodeVersionedJson<ExampleDocument>(JSON.stringify({ schemaVersion: 3, name: 'current' }), {
        currentVersion: 3,
        readVersion: (value) =>
          typeof value === 'object' && value !== null && 'schemaVersion' in value
            ? value.schemaVersion
            : undefined,
        decode: decodeExample
      })
    ).toEqual({ status: 'valid', version: 3, value: { schemaVersion: 3, name: 'current' } })
  })

  it('returns corrupt for malformed JSON', () => {
    expect(
      decodeVersionedJson<ExampleDocument>('{ not-json', {
        currentVersion: 3,
        readVersion: () => undefined,
        decode: decodeExample
      })
    ).toEqual({ status: 'corrupt' })
  })

  it('returns unsupported for a well-formed future version without domain decoding', () => {
    let decoded = false
    expect(
      decodeVersionedJson<ExampleDocument>(JSON.stringify({ schemaVersion: 4, name: 'future' }), {
        currentVersion: 3,
        readVersion: (value) =>
          typeof value === 'object' && value !== null && 'schemaVersion' in value
            ? value.schemaVersion
            : undefined,
        decode: (value) => {
          decoded = true
          return decodeExample(value)
        }
      })
    ).toEqual({ status: 'unsupported', version: 4 })
    expect(decoded).toBe(false)
  })

  it('returns legacy for a registered historical version that passes domain decoding', () => {
    expect(
      decodeVersionedJson<ExampleDocument>(
        JSON.stringify({ schemaVersion: 2, name: 'historical' }),
        {
          currentVersion: 3,
          legacyVersions: [2],
          readVersion: (value) =>
            typeof value === 'object' && value !== null && 'schemaVersion' in value
              ? value.schemaVersion
              : undefined,
          decode: decodeExample
        }
      )
    ).toEqual({
      status: 'legacy',
      version: 2,
      value: { schemaVersion: 2, name: 'historical' }
    })
  })

  it('returns legacy for an explicitly supported unversioned document', () => {
    expect(
      decodeVersionedJson<{ name: string }>(JSON.stringify({ name: 'unversioned' }), {
        currentVersion: 1,
        readVersion: (value) =>
          typeof value === 'object' && value !== null && 'schemaVersion' in value
            ? value.schemaVersion
            : undefined,
        decode: () => undefined,
        decodeUnversioned: (value) =>
          typeof value === 'object' && value !== null && 'name' in value
            ? { name: String(value.name) }
            : undefined
      })
    ).toEqual({ status: 'legacy', value: { name: 'unversioned' } })
  })
})

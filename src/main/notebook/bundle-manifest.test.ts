import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  listVersions,
  manifestUrl,
  packId,
  packUrl,
  parseManifest,
  resolvePack,
  verifyPackChecksum,
  type BundleManifest
} from './bundle-manifest'

// A well-formed multi-version manifest; individual tests clone + corrupt one field.
const validManifest = (): BundleManifest => ({
  schema: 1,
  envVersion: 1,
  subdir: 'osx-arm64',
  packs: {
    'python-3.11': {
      language: 'python',
      version: '3.11',
      file: 'python-3.11.tar.zst',
      sha256: 'a'.repeat(64),
      size: 4096
    },
    'python-3.12': {
      language: 'python',
      version: '3.12',
      file: 'python-3.12.tar.zst',
      sha256: 'b'.repeat(64),
      size: 5120
    },
    'r-4.3': {
      language: 'r',
      version: '4.3',
      file: 'r-4.3.tar.zst',
      sha256: 'c'.repeat(64),
      size: 2048
    }
  }
})

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-manifest-'))

describe('packId', () => {
  it('composes <language>-<version>', () => {
    expect(packId('python', '3.13')).toBe('python-3.13')
    expect(packId('r', '4.4')).toBe('r-4.4')
  })
})

describe('parseManifest', () => {
  it('accepts a valid manifest and round-trips its fields', () => {
    const parsed = parseManifest(JSON.stringify(validManifest()))
    expect(parsed).toEqual(validManifest())
  })

  it('rejects non-JSON text', () => {
    expect(() => parseManifest('not json')).toThrow(/valid JSON/)
  })

  it('rejects a non-object top level', () => {
    expect(() => parseManifest('42')).toThrow(/JSON object/)
  })

  it('rejects a missing/non-number schema', () => {
    const m = validManifest() as Record<string, unknown>
    delete m.schema
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/schema/)
  })

  it('rejects a missing envVersion', () => {
    const m = validManifest() as Record<string, unknown>
    delete m.envVersion
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/envVersion/)
  })

  it('rejects a missing packs object', () => {
    const m = validManifest() as Record<string, unknown>
    delete m.packs
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/packs/)
  })

  it('rejects an empty packs map', () => {
    const m = validManifest()
    m.packs = {}
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/empty/)
  })

  it('rejects an invalid language', () => {
    const m = validManifest()
    ;(m.packs['python-3.11'] as Record<string, unknown>).language = 'ruby'
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/language/)
  })

  it('rejects a missing version', () => {
    const m = validManifest()
    ;(m.packs['python-3.11'] as Record<string, unknown>).version = ''
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/version/)
  })

  it('rejects a malformed sha256 shape', () => {
    const m = validManifest()
    m.packs['python-3.11'].sha256 = 'xyz'
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/sha256/)
  })

  it('rejects a malformed size', () => {
    const m = validManifest()
    ;(m.packs['python-3.11'] as Record<string, unknown>).size = 'big'
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/size/)
  })

  it('rejects a key that disagrees with its language/version', () => {
    const m = validManifest()
    // Move the python-3.11 entry under a mismatched key.
    m.packs['python-9.9'] = m.packs['python-3.11']
    delete (m.packs as Record<string, unknown>)['python-3.11']
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/does not match/)
  })
})

describe('resolvePack + listVersions', () => {
  it('resolves the single pack entry for a (language, version)', () => {
    const m = validManifest()
    expect(resolvePack(m, 'python', '3.12')).toBe(m.packs['python-3.12'])
    expect(resolvePack(m, 'r', '4.3')).toBe(m.packs['r-4.3'])
  })

  it('returns undefined for a version that was not published', () => {
    expect(resolvePack(validManifest(), 'r', '9.9')).toBeUndefined()
  })

  it('lists the curated versions for a language, ascending', () => {
    const m = validManifest()
    expect(listVersions(m, 'python')).toEqual(['3.11', '3.12'])
    expect(listVersions(m, 'r')).toEqual(['4.3'])
  })
})

describe('verifyPackChecksum', () => {
  it('passes for a file with the right sha256 (real digest) and size', async () => {
    const root = makeRoot()
    const file = join(root, 'pack.lock')
    const content = 'pack-bytes'
    writeFileSync(file, content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    await expect(
      verifyPackChecksum(file, { sha256, size: Buffer.byteLength(content) })
    ).resolves.toBeUndefined()
  })

  it('throws on a wrong sha256', async () => {
    const root = makeRoot()
    const file = join(root, 'pack.lock')
    writeFileSync(file, 'pack-bytes')
    await expect(verifyPackChecksum(file, { sha256: 'e'.repeat(64) })).rejects.toThrow(
      /sha256 mismatch/
    )
  })

  it('throws on a size mismatch before hashing', async () => {
    const root = makeRoot()
    const file = join(root, 'pack.lock')
    const content = 'pack-bytes'
    writeFileSync(file, content)
    const sha256 = createHash('sha256').update(content).digest('hex')
    await expect(verifyPackChecksum(file, { sha256, size: 9999 })).rejects.toThrow(/size mismatch/)
  })

  it('uses an injected hasher when provided', async () => {
    const root = makeRoot()
    const file = join(root, 'pack.lock')
    writeFileSync(file, 'ignored-by-fake')
    const sha256 = async (): Promise<string> => 'f'.repeat(64)
    await expect(
      verifyPackChecksum(file, { sha256: 'f'.repeat(64) }, { sha256 })
    ).resolves.toBeUndefined()
  })
})

describe('url helpers', () => {
  it('builds the manifest key', () => {
    expect(manifestUrl('https://cdn.example/envs', 1, 'osx-arm64')).toBe(
      'https://cdn.example/envs/runtime-bundle/1/osx-arm64/manifest.json'
    )
  })

  it('builds the pack key from a manifest entry file', () => {
    expect(packUrl('https://cdn.example/envs', 1, 'linux-64', 'python-3.11.tar.zst')).toBe(
      'https://cdn.example/envs/runtime-bundle/1/linux-64/python-3.11.tar.zst'
    )
    expect(packUrl('https://cdn.example/envs', 2, 'win-64', 'r-4.4.tar.zst')).toBe(
      'https://cdn.example/envs/runtime-bundle/2/win-64/r-4.4.tar.zst'
    )
  })
})

import { describe, expect, it, vi } from 'vitest'

import { VERSIONS, packArchiveFile, packId } from './stage-default-envs.mjs'
import {
  runtimeManifestUrl,
  validatePublishedManifest,
  verifyRuntimeBundle
} from './verify-runtime-bundle.mjs'

const manifest = (subdir = 'osx-arm64', envVersion = 1): Record<string, unknown> => ({
  schema: 1,
  envVersion,
  subdir,
  packs: Object.fromEntries(
    Object.entries(VERSIONS).flatMap(([language, versions]) =>
      versions.map((version) => [
        packId(language, version),
        {
          language,
          version,
          file: packArchiveFile(language, version),
          sha256: 'a'.repeat(64),
          size: 42
        }
      ])
    )
  )
})

describe('runtime bundle release preflight', () => {
  it('builds the same immutable CDN path as the runtime client', () => {
    expect(runtimeManifestUrl('https://cdn.example/root/', 3, 'win-64')).toBe(
      'https://cdn.example/root/runtime-bundle/3/win-64/manifest.json'
    )
  })

  it('accepts a complete canonical manifest', () => {
    expect(() => validatePublishedManifest(manifest(), 1, 'osx-arm64')).not.toThrow()
  })

  it('rejects the wrong platform and missing curated packs', () => {
    expect(() => validatePublishedManifest(manifest('linux-64'), 1, 'osx-arm64')).toThrow(/subdir/)
    const incomplete = manifest() as { packs: Record<string, unknown> }
    delete incomplete.packs['python-3.12']
    expect(() => validatePublishedManifest(incomplete, 1, 'osx-arm64')).toThrow(
      /missing python-3.12/
    )
  })

  it('fails closed on an unavailable manifest', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }))
    await expect(
      verifyRuntimeBundle('https://cdn.example', 1, ['linux-64'], fetchImpl)
    ).rejects.toThrow(/HTTP 404/)
  })
})

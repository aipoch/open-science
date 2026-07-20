import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { PINNED, SUBDIRS, resolveVersion, verifyArchiveDigest } from './fetch-micromamba.mjs'

describe('micromamba pinning', () => {
  it('pins a concrete version, never `latest`', () => {
    expect(PINNED.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(PINNED.version).not.toBe('latest')
  })

  it('has a valid sha256 for every supported subdir', () => {
    for (const subdir of SUBDIRS) {
      expect(PINNED.sha256[subdir], `missing digest for ${subdir}`).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('verifyArchiveDigest', () => {
  it('accepts a buffer whose sha256 matches the pinned digest', () => {
    const buf = Buffer.from('micromamba archive bytes')
    // Register a temporary subdir pinned to this buffer's real hash, then verify it passes.
    const fake = '__test-match__'
    PINNED.sha256[fake] = createHash('sha256').update(buf).digest('hex')
    try {
      expect(() => verifyArchiveDigest(buf, fake)).not.toThrow()
    } finally {
      delete PINNED.sha256[fake]
    }
  })

  it('throws on a digest mismatch before any copy', () => {
    expect(() => verifyArchiveDigest(Buffer.from('tampered'), 'linux-64')).toThrow(
      /sha256 mismatch/
    )
  })

  it('throws when a subdir has no pinned digest', () => {
    expect(() => verifyArchiveDigest(Buffer.from('x'), 'nonexistent-subdir')).toThrow(
      /no pinned sha256/
    )
  })
})

describe('resolveVersion', () => {
  it('uses the pinned version when MICROMAMBA_VERSION is unset', () => {
    expect(resolveVersion({})).toBe(PINNED.version)
  })

  it('allows an override equal to the pinned version', () => {
    expect(resolveVersion({ MICROMAMBA_VERSION: PINNED.version })).toBe(PINNED.version)
  })

  it('fails fast on an override that differs from the pinned version', () => {
    // The digests only cover PINNED.version, so a different version can never verify — reject it
    // BEFORE any fetch, with actionable guidance instead of a confusing sha256 mismatch.
    expect(() => resolveVersion({ MICROMAMBA_VERSION: '9.9.9' })).toThrow(
      /does not match the pinned .* update scripts\/micromamba-versions\.json/s
    )
  })
})

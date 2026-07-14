import { describe, expect, it, vi } from 'vitest'

import { fetchManifest, parseManifest } from './manifest'

const valid = {
  version: '0.3.0',
  releaseDate: '2026-07-13',
  notes: 'n',
  downloads: { 'mac-arm64': { url: 'https://cdn/a.dmg', size: 1, sha256: 'h' } }
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(valid).version).toBe('0.3.0')
  })
  it('defaults missing releaseDate/notes to empty strings', () => {
    const m = parseManifest({ version: '1.0.0', downloads: {} })
    expect(m.releaseDate).toBe('')
    expect(m.notes).toBe('')
  })
  it('throws on missing version', () => {
    expect(() => parseManifest({ downloads: {} })).toThrow()
  })
  it('throws on a malformed download entry', () => {
    expect(() => parseManifest({ version: '1.0.0', downloads: { x: { url: 1 } } })).toThrow()
  })
})

describe('fetchManifest', () => {
  it('fetches and parses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(valid) })
    const m = await fetchManifest('https://cdn/version.json', fetchImpl as unknown as typeof fetch)
    expect(m.version).toBe('0.3.0')
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn/version.json', expect.any(Object))
  })
  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(
      fetchManifest('https://cdn/version.json', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow()
  })
})

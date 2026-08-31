import { describe, expect, it, vi } from 'vitest'

import { fetchManifest, parseManifest } from './manifest'

const valid = {
  version: '0.3.0',
  releaseDate: '2026-07-13',
  notes: 'n',
  localizedNotes: { 'zh-Hans': '更新说明', ja: '更新内容', es: 'Notas de la versión' },
  downloads: { 'mac-arm64': { url: 'https://cdn/a.dmg', size: 1, sha256: 'a'.repeat(64) } }
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseManifest(valid)).toMatchObject({
      version: '0.3.0',
      localizedNotes: { 'zh-Hans': '更新说明', ja: '更新内容', es: 'Notas de la versión' }
    })
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
  it('throws on unsupported or malformed localized release notes', () => {
    expect(() =>
      parseManifest({ version: '1.0.0', downloads: {}, localizedNotes: { de: 'Neu' } })
    ).toThrow(/de/)
    expect(() =>
      parseManifest({ version: '1.0.0', downloads: {}, localizedNotes: { fr: '' } })
    ).toThrow(/fr/)
  })

  it.each([
    ['an empty version', { ...valid, version: '' }],
    ['a partial numeric version', { ...valid, version: '1.2.3broken' }],
    ['an array downloads value', { ...valid, downloads: [] }],
    ['an unknown platform key', { ...valid, downloads: { solaris: valid.downloads['mac-arm64'] } }],
    [
      'a relative download URL',
      {
        ...valid,
        downloads: { 'mac-arm64': { ...valid.downloads['mac-arm64'], url: '/installer.dmg' } }
      }
    ],
    [
      'an HTTP download URL',
      {
        ...valid,
        downloads: {
          'mac-arm64': { ...valid.downloads['mac-arm64'], url: 'http://cdn/installer.dmg' }
        }
      }
    ],
    [
      'a non-positive download size',
      {
        ...valid,
        downloads: { 'mac-arm64': { ...valid.downloads['mac-arm64'], size: 0 } }
      }
    ],
    [
      'a negative download size',
      {
        ...valid,
        downloads: { 'mac-arm64': { ...valid.downloads['mac-arm64'], size: -1 } }
      }
    ],
    [
      'a NaN download size',
      {
        ...valid,
        downloads: { 'mac-arm64': { ...valid.downloads['mac-arm64'], size: Number.NaN } }
      }
    ],
    [
      'a non-finite download size',
      {
        ...valid,
        downloads: {
          'mac-arm64': { ...valid.downloads['mac-arm64'], size: Number.POSITIVE_INFINITY }
        }
      }
    ],
    [
      'a non-integer download size',
      {
        ...valid,
        downloads: { 'mac-arm64': { ...valid.downloads['mac-arm64'], size: 1.5 } }
      }
    ],
    [
      'an unsafe download size',
      {
        ...valid,
        downloads: {
          'mac-arm64': { ...valid.downloads['mac-arm64'], size: Number.MAX_SAFE_INTEGER + 1 }
        }
      }
    ],
    [
      'a malformed SHA-256',
      {
        ...valid,
        downloads: { 'mac-arm64': { ...valid.downloads['mac-arm64'], sha256: 'not-a-sha256' } }
      }
    ]
  ])('rejects %s', (_label, manifest) => {
    expect(() => parseManifest(manifest)).toThrow()
  })
})

describe('fetchManifest', () => {
  it('fetches and parses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(valid), { status: 200 }))
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

  it('aborts a manifest request at its independent deadline', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }) as unknown as typeof fetch

    try {
      const pending = fetchManifest('https://cdn/version.json', fetchImpl)
      controller.abort(new DOMException('manifest deadline', 'TimeoutError'))
      const outcome = await Promise.race([
        pending.then(
          () => 'resolved',
          () => 'rejected'
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])

      expect(timeout).toHaveBeenCalledWith(15_000)
      expect(outcome).toBe('rejected')
    } finally {
      timeout.mockRestore()
    }
  })

  it('rejects a manifest response whose streamed body exceeds the byte ceiling', async () => {
    const oversized = JSON.stringify({ ...valid, notes: 'x'.repeat(300_000) })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(oversized, { status: 200 }))

    await expect(
      fetchManifest('https://cdn/version.json', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/manifest.*bytes/i)
  })
})

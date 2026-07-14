import type { PlatformDownload, UpdateManifest } from '../../shared/update'

const isDownload = (value: unknown): value is PlatformDownload => {
  const d = value as PlatformDownload
  return (
    !!d && typeof d.url === 'string' && typeof d.size === 'number' && typeof d.sha256 === 'string'
  )
}

// Validates the untrusted CDN payload into a typed manifest. releaseDate/notes are optional in
// practice, so they default to '' rather than failing the whole check.
export const parseManifest = (data: unknown): UpdateManifest => {
  const m = data as UpdateManifest
  if (
    !m ||
    typeof m.version !== 'string' ||
    typeof m.downloads !== 'object' ||
    m.downloads === null
  ) {
    throw new Error('Invalid update manifest')
  }
  for (const [key, value] of Object.entries(m.downloads)) {
    if (!isDownload(value)) throw new Error(`Invalid download entry: ${key}`)
  }
  return {
    version: m.version,
    releaseDate: typeof m.releaseDate === 'string' ? m.releaseDate : '',
    notes: typeof m.notes === 'string' ? m.notes : '',
    downloads: m.downloads
  }
}

export const fetchManifest = async (
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateManifest> => {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`)
  return parseManifest(await response.json())
}

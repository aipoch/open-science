import { netFetchStandard } from '../skills/net-fetch'
import type { LocalizedReleaseNotes, PlatformDownload, UpdateManifest } from '../../shared/update'

const LOCALIZED_NOTE_LOCALES = new Set([
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'fr',
  'pt-PT',
  'ru',
  'es'
])

const isDownload = (value: unknown): value is PlatformDownload => {
  const d = value as PlatformDownload
  return (
    !!d && typeof d.url === 'string' && typeof d.size === 'number' && typeof d.sha256 === 'string'
  )
}

const parseLocalizedNotes = (value: unknown): LocalizedReleaseNotes | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid localized release notes')
  }

  const localizedNotes: LocalizedReleaseNotes = {}
  for (const [locale, notes] of Object.entries(value)) {
    if (!LOCALIZED_NOTE_LOCALES.has(locale) || typeof notes !== 'string' || !notes.trim()) {
      throw new Error(`Invalid localized release notes: ${locale}`)
    }
    localizedNotes[locale as keyof LocalizedReleaseNotes] = notes
  }
  return Object.keys(localizedNotes).length > 0 ? localizedNotes : undefined
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
    localizedNotes: parseLocalizedNotes(m.localizedNotes),
    downloads: m.downloads
  }
}

export const fetchManifest = async (
  url: string,
  // Default to the proxy-aware net.fetch so the manifest request honors the system/VPN proxy,
  // matching the installer download and language-pack fetch. Node's global fetch bypasses it.
  fetchImpl: typeof fetch = netFetchStandard
): Promise<UpdateManifest> => {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`)
  return parseManifest(await response.json())
}

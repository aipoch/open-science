import { netFetchStandard } from '../skills/net-fetch'
import type { LocalizedReleaseNotes, PlatformDownload, UpdateManifest } from '../../shared/update'

const LOCALIZED_NOTE_LOCALES = new Set([
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'fr',
  'pt-BR',
  'ru',
  'de',
  'es'
])
const DOWNLOAD_KEYS = new Set([
  'mac-arm64',
  'mac-x64',
  'win-x64',
  'linux-x64-appimage',
  'linux-x64-deb'
])
const MANIFEST_TIMEOUT_MS = 15_000
const MAX_MANIFEST_BYTES = 256 * 1024

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype

const isReleaseVersion = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value) &&
  value.split('.').every((part) => Number.isSafeInteger(Number(part)))

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const isDownload = (value: unknown): value is PlatformDownload => {
  if (!isPlainObject(value)) return false
  const d = value as Partial<PlatformDownload>
  return (
    isHttpsUrl(d.url) &&
    Number.isSafeInteger(d.size) &&
    (d.size ?? 0) > 0 &&
    typeof d.sha256 === 'string' &&
    /^[a-f0-9]{64}$/iu.test(d.sha256)
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
  if (!isPlainObject(data) || !isReleaseVersion(data.version) || !isPlainObject(data.downloads)) {
    throw new Error('Invalid update manifest')
  }

  const downloads: Record<string, PlatformDownload> = {}
  for (const [key, value] of Object.entries(data.downloads)) {
    if (!DOWNLOAD_KEYS.has(key) || !isDownload(value)) {
      throw new Error(`Invalid download entry: ${key}`)
    }
    downloads[key] = value
  }
  return {
    version: data.version,
    releaseDate: typeof data.releaseDate === 'string' ? data.releaseDate : '',
    notes: typeof data.notes === 'string' ? data.notes : '',
    localizedNotes: parseLocalizedNotes(data.localizedNotes),
    downloads
  }
}

const readManifestBody = async (response: Response): Promise<string> => {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_MANIFEST_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Manifest response exceeded ${MAX_MANIFEST_BYTES} bytes`)
  }
  if (!response.body) throw new Error('Manifest response had no body')

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_MANIFEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Manifest response exceeded ${MAX_MANIFEST_BYTES} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

export const fetchManifest = async (
  url: string,
  // Default to the proxy-aware net.fetch so the manifest request honors the system/VPN proxy,
  // matching the installer download and language-pack fetch. Node's global fetch bypasses it.
  fetchImpl: typeof fetch = netFetchStandard
): Promise<UpdateManifest> => {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`)
  return parseManifest(JSON.parse(await readManifestBody(response)))
}

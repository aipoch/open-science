import type { DownloadProgress } from '@aipoch/resilient-download'
import type { Locale } from './locale'

export type LocalModelCapability = 'pdf-tables' | 'pdf-translation' | 'ocr'

export const OCR_LANGUAGES = [
  'eng',
  'chi_sim',
  'chi_tra',
  'deu',
  'spa',
  'fra',
  'jpn',
  'kor',
  'rus'
] as const
export type OcrLanguage = (typeof OCR_LANGUAGES)[number]

export const OCR_LANGUAGE_LABELS: Readonly<Record<OcrLanguage, string>> = {
  eng: 'English',
  chi_sim: 'Simplified Chinese',
  chi_tra: 'Traditional Chinese',
  deu: 'German',
  spa: 'Spanish',
  fra: 'French',
  jpn: 'Japanese',
  kor: 'Korean',
  rus: 'Russian'
}

export const isOcrLanguage = (value: unknown): value is OcrLanguage =>
  typeof value === 'string' && (OCR_LANGUAGES as readonly string[]).includes(value)

export const defaultOcrLanguagesForLocale = (locale: Locale): readonly OcrLanguage[] => {
  const language = (
    {
      en: 'eng',
      'zh-Hans': 'chi_sim',
      'zh-Hant': 'chi_tra',
      ja: 'jpn',
      ko: 'kor',
      fr: 'fra',
      ru: 'rus',
      de: 'deu',
      es: 'spa'
    } as const
  )[locale]
  return language === 'eng' ? ['eng'] : ['eng', language]
}

export type LocalModelAvailability = 'notInstalled' | 'installing' | 'ready' | 'error'

export type LocalModelSnapshot = Readonly<{
  availability: LocalModelAvailability
  recommendedRevision: string
  installedRevision?: string
  downloadBytes: number
  installedBytes: number
  hasFiles: boolean
  inUse: boolean
  transferredBytes: number
  downloadProgress?: DownloadProgress
  updateAvailable: boolean
  error?: 'download' | 'integrity' | 'storage' | 'incompatible'
  ocrLanguages?: readonly Readonly<{
    code: OcrLanguage
    label: string
    selected: boolean
    installed: boolean
    downloadBytes: number
    installedBytes: number
    availability: LocalModelAvailability
    inUse: boolean
    error?: 'download' | 'integrity' | 'storage' | 'incompatible'
  }>[]
  selectedOcrLanguages?: readonly OcrLanguage[]
}>

export const localModelDownloadProgress = (snapshot: LocalModelSnapshot): DownloadProgress =>
  snapshot.downloadProgress ?? {
    phase: 'downloading',
    transferred: snapshot.transferredBytes,
    total: snapshot.downloadBytes,
    percent:
      snapshot.downloadBytes > 0
        ? Math.min(100, Math.round((snapshot.transferredBytes / snapshot.downloadBytes) * 100))
        : undefined,
    bytesPerSecond: 0,
    attempt: 0
  }
export const LOCAL_MODEL_NOT_INSTALLED = 'Local model is not installed.'
export const PDF_MODEL_CHANGED =
  'PDF_MODEL_CHANGED: The active model changed while parsing was queued. Retry with the current revision.'

export type LocalModelApi = Readonly<{
  getSnapshot(capability?: LocalModelCapability): Promise<LocalModelSnapshot>
  install(capability?: LocalModelCapability): Promise<LocalModelSnapshot>
  cancel(capability?: LocalModelCapability): Promise<LocalModelSnapshot>
  remove(capability?: LocalModelCapability): Promise<LocalModelSnapshot>
  setOcrLanguages(languages: readonly OcrLanguage[]): Promise<LocalModelSnapshot>
}>

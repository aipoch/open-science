import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  OCR_LANGUAGE_LABELS,
  OCR_LANGUAGES,
  LOCAL_MODEL_NOT_INSTALLED,
  isOcrLanguage,
  type LocalModelSnapshot,
  type OcrLanguage
} from '../../shared/local-models'
import { acquireDataRootWriter } from '../storage/migration-state'
import { resolveDataRoot } from '../storage-root'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import type { LocalModelOwner, LocalModelUse } from './owner'

const SELECTION_SCHEMA_VERSION = 1
const LEGACY_BASE_LANGUAGE_REVISION = 'ocr-7ed9791930e614a1'
class UnsafeOcrModelPathError extends Error {}

type OcrSelection = Readonly<{
  schemaVersion: typeof SELECTION_SCHEMA_VERSION
  languages: readonly OcrLanguage[]
}>

type OcrLanguageOwnerOptions = Readonly<{
  base: LocalModelOwner
  languagePacks: Readonly<Partial<Record<OcrLanguage, LocalModelOwner>>>
  defaultLanguages: readonly OcrLanguage[]
  dataRoot?: () => string
}>

const normalizeLanguages = (languages: readonly OcrLanguage[]): OcrLanguage[] => {
  const unique = [...new Set(languages)].filter(isOcrLanguage)
  return ['eng', ...unique.filter((language) => language !== 'eng')]
}

const validSelection = (value: unknown): value is OcrSelection =>
  typeof value === 'object' &&
  value !== null &&
  'schemaVersion' in value &&
  value.schemaVersion === SELECTION_SCHEMA_VERSION &&
  'languages' in value &&
  Array.isArray(value.languages) &&
  value.languages.length > 0 &&
  value.languages.every(isOcrLanguage)

const languageAsset = (
  use: LocalModelUse,
  code: OcrLanguage
): LocalModelUse['assets'][number] | null =>
  use.assets.find((asset) => asset.file === `${code}.traineddata.gz`) ?? null

export const createLocalOcrModelOwner = ({
  base,
  languagePacks,
  defaultLanguages,
  dataRoot = resolveDataRoot
}: OcrLanguageOwnerOptions): LocalModelOwner => {
  let initialized: Promise<void> | undefined
  let selectedLanguages = normalizeLanguages(defaultLanguages)
  const selectionDirectory = async (create: boolean): Promise<string | undefined> => {
    let path = dataRoot()
    if (create) await mkdir(path, { recursive: true })
    for (const part of ['models', 'ocr']) {
      path = join(path, part)
      if (create)
        await mkdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!info) return undefined
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new UnsafeOcrModelPathError('Unsafe OCR model directory.')
    }
    return path
  }

  const initialize = (): Promise<void> => {
    initialized ??= (async () => {
      try {
        const directory = await selectionDirectory(false)
        if (!directory) return
        const selection = JSON.parse(
          await readFile(join(directory, 'languages.json'), 'utf8')
        ) as unknown
        if (validSelection(selection)) selectedLanguages = normalizeLanguages(selection.languages)
      } catch (error) {
        if (error instanceof UnsafeOcrModelPathError) throw error
        // The default follows the locale until the user explicitly changes it.
      }
    })()
    return initialized
  }

  const snapshot = async (): Promise<LocalModelSnapshot> => {
    await initialize()
    const [baseSnapshot, ...packSnapshots] = await Promise.all([
      base.getSnapshot(),
      ...OCR_LANGUAGES.map((code) => languagePacks[code]?.getSnapshot())
    ])
    const packs = new Map<OcrLanguage, LocalModelSnapshot | undefined>()
    OCR_LANGUAGES.forEach((code, index) => packs.set(code, packSnapshots[index]))
    const legacyBaseLanguages =
      baseSnapshot.installedRevision === LEGACY_BASE_LANGUAGE_REVISION
        ? new Set<OcrLanguage>(['eng', 'chi_sim'])
        : new Set<OcrLanguage>()
    const languages = OCR_LANGUAGES.map((code) => {
      const pack = packs.get(code)
      const installed = pack?.availability === 'ready' || legacyBaseLanguages.has(code)
      return {
        code,
        label: OCR_LANGUAGE_LABELS[code],
        selected: selectedLanguages.includes(code),
        installed,
        downloadBytes: pack?.downloadBytes ?? 0,
        installedBytes: pack?.installedBytes ?? 0,
        availability: legacyBaseLanguages.has(code)
          ? 'ready'
          : (pack?.availability ?? 'notInstalled'),
        inUse: pack?.inUse ?? false,
        ...(pack?.error ? { error: pack.error } : {})
      }
    })
    const selectedPacks = languages.filter((language) => language.selected)
    const selectedPackError = selectedPacks.find((language) => language.error)?.error
    const installing =
      baseSnapshot.availability === 'installing' ||
      selectedPacks.some((language) => language.availability === 'installing')
    const availability = installing
      ? 'installing'
      : baseSnapshot.availability === 'error' || selectedPackError
        ? 'error'
        : baseSnapshot.availability
    return {
      ...baseSnapshot,
      availability,
      ...(baseSnapshot.error || selectedPackError
        ? { error: baseSnapshot.error ?? selectedPackError }
        : { error: undefined }),
      downloadBytes:
        baseSnapshot.downloadBytes +
        selectedPacks.reduce(
          (total, language) => total + (language.installed ? 0 : language.downloadBytes),
          0
        ),
      installedBytes:
        baseSnapshot.installedBytes +
        languages.reduce((total, language) => total + language.installedBytes, 0),
      hasFiles: baseSnapshot.hasFiles || languages.some((language) => language.installedBytes > 0),
      inUse: baseSnapshot.inUse || languages.some((language) => language.inUse),
      updateAvailable:
        baseSnapshot.updateAvailable ||
        selectedPacks.some(
          (language) => !language.installed || packs.get(language.code)?.updateAvailable
        ),
      ocrLanguages: languages,
      selectedOcrLanguages: selectedLanguages
    }
  }

  const setOcrLanguages = async (
    languages: readonly OcrLanguage[]
  ): Promise<LocalModelSnapshot> => {
    await initialize()
    const next = normalizeLanguages(languages)
    const release = acquireDataRootWriter()
    try {
      const directory = await selectionDirectory(true)
      if (!directory) throw new Error('OCR model directory is unavailable.')
      await writeDurableJsonFile(
        join(directory, 'languages.json'),
        JSON.stringify({
          schemaVersion: SELECTION_SCHEMA_VERSION,
          languages: next
        } satisfies OcrSelection)
      )
      selectedLanguages = next
    } finally {
      release()
    }
    return snapshot()
  }

  const install = async (): Promise<LocalModelSnapshot> => {
    await initialize()
    await base.install()
    await Promise.all(selectedLanguages.map((code) => languagePacks[code]?.install()))
    return snapshot()
  }

  const cancel = async (): Promise<LocalModelSnapshot> => {
    await Promise.all([
      base.cancel(),
      ...Object.values(languagePacks).map((owner) => owner?.cancel())
    ])
    return snapshot()
  }

  const remove = async (): Promise<LocalModelSnapshot> => {
    await Promise.all([
      base.remove(),
      ...Object.values(languagePacks).map((owner) => owner?.remove())
    ])
    return snapshot()
  }

  const acquireUse = async (
    languages: readonly OcrLanguage[] = selectedLanguages
  ): Promise<LocalModelUse> => {
    await initialize()
    const baseUse = await base.acquireUse()
    const selected = normalizeLanguages(languages)
    const acquired: LocalModelUse[] = [baseUse]
    try {
      for (const code of selected) {
        const owner = languagePacks[code]
        if (!owner) continue
        const pack = await owner.getSnapshot()
        if (pack.availability !== 'ready') continue
        acquired.push(await owner.acquireUse())
      }
      const available = selected.filter(
        (code) => languageAsset(baseUse, code) || acquired.some((use) => languageAsset(use, code))
      )
      if (available.length === 0) throw new Error(LOCAL_MODEL_NOT_INSTALLED)
      const revision = `${baseUse.revision}:${available.join(',')}`
      return {
        revision,
        languages: available,
        assets: acquired.flatMap((use) => use.assets),
        release: () => acquired.reverse().forEach((use) => use.release())
      }
    } catch (error) {
      acquired.reverse().forEach((use) => use.release())
      throw error
    }
  }

  return {
    acquireUse,
    close: async () => {
      await Promise.all([
        base.close(),
        ...Object.values(languagePacks).map((owner) => owner?.close())
      ])
    },
    getSnapshot: snapshot,
    install,
    cancel,
    remove,
    setOcrLanguages
  }
}

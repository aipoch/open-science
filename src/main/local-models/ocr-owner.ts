import { lstat, mkdir } from 'node:fs/promises'
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
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import type { LocalModelOwner, LocalModelUse } from './owner'

const SELECTION_SCHEMA_VERSION = 1
const SELECTION_MAX_BYTES = 16 * 1024
const LEGACY_BASE_LANGUAGE_REVISION = 'ocr-7ed9791930e614a1'
class UnsafeOcrModelPathError extends Error {}

type OcrSelection = Readonly<{
  schemaVersion: typeof SELECTION_SCHEMA_VERSION
  languages: readonly OcrLanguage[]
}>

type OcrLanguageOwnerOptions = Readonly<{
  base: LocalModelOwner
  languagePacks: Readonly<Partial<Record<OcrLanguage, LocalModelOwner>>>
  defaultLanguages: readonly OcrLanguage[] | (() => readonly OcrLanguage[])
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
  const getDefaultLanguages =
    typeof defaultLanguages === 'function' ? defaultLanguages : () => defaultLanguages
  let initialized: Promise<void> | undefined
  let selectedLanguages = normalizeLanguages(getDefaultLanguages())
  let hasExplicitSelection = false
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
        const selectionPath = join(directory, 'languages.json')
        const info = await lstat(selectionPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (!info) return
        if (!info.isFile() || info.isSymbolicLink())
          throw new UnsafeOcrModelPathError('Unsafe OCR model selection file.')
        const selection = JSON.parse(
          await readFileWithinLimit(selectionPath, SELECTION_MAX_BYTES)
        ) as unknown
        if (validSelection(selection)) {
          selectedLanguages = normalizeLanguages(selection.languages)
          hasExplicitSelection = true
        }
      } catch (error) {
        if (error instanceof UnsafeOcrModelPathError) throw error
        // The default follows the locale until the user explicitly changes it.
      }
    })()
    return initialized
  }

  const snapshot = async (): Promise<LocalModelSnapshot> => {
    await initialize()
    if (!hasExplicitSelection) selectedLanguages = normalizeLanguages(getDefaultLanguages())
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
    if (legacyBaseLanguages.size > 0) {
      // The legacy worker ignores workerData and always loads its embedded English and
      // Simplified Chinese files. Do not expose a selectable projection until it is upgraded.
      selectedLanguages = [...legacyBaseLanguages]
      hasExplicitSelection = false
    }
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
    const downloadParts = [
      {
        snapshot: baseSnapshot,
        included: !baseSnapshot.installedRevision || baseSnapshot.updateAvailable
      },
      ...selectedPacks.map((language) => {
        const pack = packs.get(language.code)
        return {
          snapshot: pack,
          included: Boolean(pack && (!language.installed || pack.updateAvailable))
        }
      })
    ].filter(
      (part): part is { snapshot: LocalModelSnapshot; included: boolean } =>
        part.snapshot !== undefined && part.included
    )
    const downloadBytes = downloadParts.reduce(
      (total, part) => total + part.snapshot.downloadBytes,
      0
    )
    const transferredBytes = downloadParts.reduce(
      (total, part) => total + part.snapshot.transferredBytes,
      0
    )
    const activeProgress = downloadParts.flatMap((part) =>
      part.snapshot.downloadProgress ? [part.snapshot.downloadProgress] : []
    )
    const bytesPerSecond = activeProgress.reduce(
      (total, progress) => total + progress.bytesPerSecond,
      0
    )
    const downloadProgress =
      activeProgress.length === 0
        ? undefined
        : {
            phase: activeProgress.some((progress) => progress.phase === 'downloading')
              ? ('downloading' as const)
              : ('reconnecting' as const),
            transferred: transferredBytes,
            total: downloadBytes,
            percent:
              downloadBytes > 0
                ? Math.min(100, Math.round((transferredBytes / downloadBytes) * 100))
                : undefined,
            bytesPerSecond,
            etaSeconds:
              bytesPerSecond > 0
                ? Math.ceil(Math.max(0, downloadBytes - transferredBytes) / bytesPerSecond)
                : undefined,
            attempt: Math.max(...activeProgress.map((progress) => progress.attempt))
          }
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
      downloadBytes,
      installedBytes:
        baseSnapshot.installedBytes +
        languages.reduce((total, language) => total + language.installedBytes, 0),
      transferredBytes,
      downloadProgress,
      hasFiles: baseSnapshot.hasFiles || languages.some((language) => language.installedBytes > 0),
      inUse: baseSnapshot.inUse || languages.some((language) => language.inUse),
      updateAvailable:
        baseSnapshot.updateAvailable ||
        selectedPacks.some(
          (language) => language.installed && Boolean(packs.get(language.code)?.updateAvailable)
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
    if ((await base.getSnapshot()).installedRevision === LEGACY_BASE_LANGUAGE_REVISION)
      await base.install()
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
      hasExplicitSelection = true
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

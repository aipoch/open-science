import { unzipSync, type UnzipFileInfo } from 'fflate'

import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  type PackageDiagnostic,
  type SpecialistPackageArchiveMetrics,
  type SpecialistPackageCatalogSnapshot,
  type SpecialistPackageValidationResult
} from '../../../shared/specialist-package'
import { validateSpecialistPackage, type SpecialistPackageFile } from './validator'

const LIMITS = SPECIALIST_PACKAGE_ARCHIVE_LIMITS
const NOISE_PATH = /(?:^|\/)(?:__MACOSX(?:\/|$)|\.DS_Store$|Thumbs\.db$)/i
const filenameDecoder = new TextDecoder()

type CentralEntry = { encrypted: boolean; link?: 'symbolic' | 'special' }

const centralEntries = (bytes: Uint8Array): Map<string, CentralEntry> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.byteLength - 22
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end -= 1
  if (end < minimum) throw new Error('missing ZIP end record')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 is not supported')
  const entries = new Map<string, CentralEntry>()
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('invalid ZIP central directory')
    }
    const madeBy = view.getUint16(offset + 4, true)
    const flags = view.getUint16(offset + 8, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const externalAttributes = view.getUint32(offset + 38, true)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.byteLength) throw new Error('invalid ZIP entry name')
    const name = filenameDecoder.decode(bytes.subarray(nameStart, nameEnd))
    const unixMode = madeBy >>> 8 === 3 ? externalAttributes >>> 16 : 0
    const fileType = unixMode & 0o170000
    const link =
      fileType === 0o120000
        ? 'symbolic'
        : fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000
          ? 'special'
          : undefined
    entries.set(name, { encrypted: Boolean(flags & 1), ...(link ? { link } : {}) })
    offset = nameEnd + extraLength + commentLength
  }
  return entries
}

const displayPath = (path: string): string => {
  const slash = path.replaceAll('\\', '/')
  const leaf = slash.split('/').filter(Boolean).at(-1)
  return leaf ? `[unsafe]/${leaf}` : '[unsafe-path]'
}

const unsafePathCode = (path: string): string | undefined => {
  if (path.startsWith('/') || path.startsWith('\\')) return 'package.archive-path-absolute'
  if (/^[A-Za-z]:/.test(path)) return 'package.archive-path-drive'
  if (path.includes('\\')) return 'package.archive-path-backslash'
  const segments = path.split('/')
  if (path.endsWith('/')) segments.pop()
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return 'package.archive-path-traversal'
  }
  return undefined
}

const issue = (
  diagnostics: PackageDiagnostic[],
  code: string,
  message: string,
  file?: Pick<UnzipFileInfo, 'name' | 'originalSize'>,
  measurement?: Pick<PackageDiagnostic, 'actual' | 'limit' | 'unit'>
): void => {
  diagnostics.push({
    severity: 'error',
    code,
    message,
    ...(file ? { path: unsafePathCode(file.name) ? displayPath(file.name) : file.name } : {}),
    ...measurement
  })
}

const scanArchive = (
  archiveBytes: Uint8Array
): {
  files?: Record<string, Uint8Array>
  diagnostics: PackageDiagnostic[]
  archive: SpecialistPackageArchiveMetrics
} => {
  const diagnostics: PackageDiagnostic[] = []
  let fileCount = 0
  let uncompressedBytes = 0
  const normalizedPaths = new Set<string>()
  const archive: SpecialistPackageArchiveMetrics = {
    compressedBytes: archiveBytes.byteLength,
    limits: LIMITS
  }

  if (archiveBytes.byteLength > LIMITS.compressedBytes) {
    issue(
      diagnostics,
      'package.archive-compressed-size-exceeded',
      'The compressed archive exceeds the safe preview limit.',
      undefined,
      { actual: archiveBytes.byteLength, limit: LIMITS.compressedBytes, unit: 'bytes' }
    )
    return { diagnostics, archive }
  }

  let extracted: Record<string, Uint8Array>
  try {
    const central = centralEntries(archiveBytes)
    extracted = unzipSync(archiveBytes, {
      filter: (file) => {
        const isDirectory = file.name.endsWith('/')
        if (!isDirectory) {
          fileCount += 1
          uncompressedBytes += file.originalSize
        }

        const pathCode = unsafePathCode(file.name)
        if (pathCode) {
          issue(diagnostics, pathCode, 'The archive entry path is unsafe.', file)
        }
        const depth = file.name.split('/').filter(Boolean).length
        if (depth > LIMITS.pathDepth) {
          issue(
            diagnostics,
            'package.archive-path-depth-exceeded',
            'The archive entry is nested too deeply.',
            file,
            {
              actual: depth,
              limit: LIMITS.pathDepth,
              unit: 'levels'
            }
          )
        }
        const normalized = file.name.normalize('NFC').toLocaleLowerCase('en-US')
        if (normalizedPaths.has(normalized)) {
          issue(
            diagnostics,
            'package.archive-path-duplicate',
            'The archive contains duplicate normalized paths.',
            file
          )
        }
        normalizedPaths.add(normalized)

        const attributes = central.get(file.name)
        if (attributes?.encrypted) {
          issue(
            diagnostics,
            'package.archive-encryption-unsupported',
            'Encrypted archive entries are not supported.',
            file
          )
        }
        if (attributes?.link) {
          issue(
            diagnostics,
            attributes.link === 'symbolic'
              ? 'package.symbolic-link-forbidden'
              : 'package.archive-link-unsupported',
            'Symbolic and hard link archive entries are not supported.',
            file
          )
        }

        if (!isDirectory && file.originalSize > LIMITS.fileBytes) {
          issue(
            diagnostics,
            'package.archive-file-size-exceeded',
            'An archive entry exceeds the safe preview limit.',
            file,
            {
              actual: file.originalSize,
              limit: LIMITS.fileBytes,
              unit: 'bytes'
            }
          )
        }
        if (file.compression !== 0 && file.compression !== 8) {
          issue(
            diagnostics,
            'package.archive-compression-unsupported',
            'The archive uses an unsupported compression method.',
            file
          )
        }
        const ratio =
          file.size === 0 ? (file.originalSize === 0 ? 0 : Infinity) : file.originalSize / file.size
        if (!isDirectory && ratio > LIMITS.compressionRatio) {
          issue(
            diagnostics,
            'package.archive-compression-ratio-exceeded',
            'The archive entry has an unsafe compression ratio.',
            file,
            {
              actual: Math.ceil(ratio),
              limit: LIMITS.compressionRatio,
              unit: 'ratio'
            }
          )
        }
        if (NOISE_PATH.test(file.name)) {
          diagnostics.push({
            severity: 'info',
            code: 'package.metadata-noise-ignored',
            message: 'Known archive metadata was ignored.',
            path: file.name
          })
          return false
        }
        return (
          !isDirectory &&
          !pathCode &&
          !attributes?.encrypted &&
          !attributes?.link &&
          fileCount <= LIMITS.fileCount &&
          uncompressedBytes <= LIMITS.uncompressedBytes &&
          file.originalSize <= LIMITS.fileBytes &&
          (file.compression === 0 || file.compression === 8) &&
          ratio <= LIMITS.compressionRatio
        )
      }
    })
  } catch {
    issue(
      diagnostics,
      'package.archive-invalid',
      'The selected file is not a readable ZIP package.'
    )
    return { diagnostics, archive: { ...archive, fileCount, uncompressedBytes } }
  }

  const metrics = { ...archive, fileCount, uncompressedBytes }
  if (fileCount > LIMITS.fileCount) {
    issue(
      diagnostics,
      'package.archive-file-count-exceeded',
      'The archive contains too many files.',
      undefined,
      {
        actual: fileCount,
        limit: LIMITS.fileCount,
        unit: 'files'
      }
    )
  }
  if (uncompressedBytes > LIMITS.uncompressedBytes) {
    issue(
      diagnostics,
      'package.archive-uncompressed-size-exceeded',
      'The expanded archive exceeds the safe preview limit.',
      undefined,
      {
        actual: uncompressedBytes,
        limit: LIMITS.uncompressedBytes,
        unit: 'bytes'
      }
    )
  }
  if (diagnostics.some((entry) => entry.severity === 'error'))
    return { diagnostics, archive: metrics }

  return { files: extracted, diagnostics, archive: metrics }
}

const isMacOsMetadata = (path: string): boolean =>
  path === '__MACOSX' || path.startsWith('__MACOSX/')

const normalizedFiles = (
  archive: Record<string, Uint8Array>
): SpecialistPackageFile[] | undefined => {
  const entries = Object.entries(archive).filter(
    ([path]) => !path.endsWith('/') && !isMacOsMetadata(path)
  )
  const rootManifest = entries.some(([path]) => path === 'manifest.json')
  const wrapperCandidates = [
    ...new Set(
      entries
        .filter(([path]) => path.split('/').length === 2 && path.endsWith('/manifest.json'))
        .map(([path]) => path.split('/')[0])
    )
  ]
  if (!rootManifest && wrapperCandidates.length !== 1) return undefined
  if (rootManifest && wrapperCandidates.length > 0) return undefined
  const prefix = rootManifest ? '' : `${wrapperCandidates[0]}/`
  if (prefix && entries.some(([path]) => !path.startsWith(prefix))) return undefined
  return entries
    .map(([path, bytes]) => ({ path: prefix ? path.slice(prefix.length) : path, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export const validateSpecialistZip = (
  archiveBytes: Uint8Array,
  catalog: SpecialistPackageCatalogSnapshot
): SpecialistPackageValidationResult => {
  const scanned = scanArchive(archiveBytes)
  if (!scanned.files) {
    return {
      preview: { diagnostics: scanned.diagnostics, installable: false, archive: scanned.archive }
    }
  }
  const files = normalizedFiles(scanned.files)
  if (!files) {
    return {
      preview: {
        diagnostics: [
          ...scanned.diagnostics,
          {
            severity: 'error',
            code: 'package.archive-layout-invalid',
            message: 'The ZIP must contain one safe root package or one wrapper directory.'
          }
        ],
        installable: false,
        archive: scanned.archive
      }
    }
  }
  const result = validateSpecialistPackage(files, catalog, 'zip')
  const diagnostics = [...scanned.diagnostics, ...result.preview.diagnostics]
  return {
    ...result,
    preview: {
      ...result.preview,
      diagnostics,
      installable: !diagnostics.some((entry) => entry.severity === 'error') && Boolean(result.plan),
      archive: scanned.archive
    }
  }
}

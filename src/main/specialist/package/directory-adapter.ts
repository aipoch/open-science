import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  type PackageDiagnostic,
  type SpecialistPackageArchiveMetrics,
  type SpecialistPackageCatalogSnapshot,
  type SpecialistPackageSource,
  type SpecialistPackageValidationResult
} from '../../../shared/specialist-package'
import { validateSpecialistPackage, type SpecialistPackageFile } from './validator'

const LIMITS = SPECIALIST_PACKAGE_ARCHIVE_LIMITS

const issue = (
  diagnostics: PackageDiagnostic[],
  code: string,
  message: string,
  path?: string,
  measurement?: Pick<PackageDiagnostic, 'actual' | 'limit' | 'unit'>
): void => {
  diagnostics.push({
    severity: 'error',
    code,
    message,
    ...(path ? { path } : {}),
    ...measurement
  })
}

const scanDirectory = async (
  root: string,
  limits = LIMITS
): Promise<{
  files?: SpecialistPackageFile[]
  diagnostics: PackageDiagnostic[]
  archive: SpecialistPackageArchiveMetrics
}> => {
  const diagnostics: PackageDiagnostic[] = []
  const files: SpecialistPackageFile[] = []
  let fileCount = 0
  let uncompressedBytes = 0
  let overflow = false

  const visit = async (relativeDirectory = ''): Promise<void> => {
    if (overflow) return
    const directory = relativeDirectory ? join(root, relativeDirectory) : root
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (overflow) return
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = join(root, ...relativePath.split('/'))
      const depth = relativePath.split('/').filter(Boolean).length
      if (depth > limits.pathDepth) {
        issue(
          diagnostics,
          'package.archive-path-depth-exceeded',
          'The archive entry is nested too deeply.',
          relativePath,
          { actual: depth, limit: limits.pathDepth, unit: 'levels' }
        )
        if (entry.isDirectory()) continue
      }
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) throw new Error('symbolic-link')
      if (metadata.isFile() && metadata.nlink > 1) throw new Error('hard-link')
      if (entry.isDirectory()) {
        await visit(relativePath)
        continue
      }
      if (!entry.isFile()) continue

      fileCount += 1
      uncompressedBytes += metadata.size
      if (fileCount > limits.fileCount || uncompressedBytes > limits.uncompressedBytes) {
        overflow = true
      }
      if (metadata.size > limits.fileBytes) {
        issue(
          diagnostics,
          'package.archive-file-size-exceeded',
          'An archive entry exceeds the safe preview limit.',
          relativePath,
          { actual: metadata.size, limit: limits.fileBytes, unit: 'bytes' }
        )
      }
      const extractable =
        depth <= limits.pathDepth &&
        metadata.size <= limits.fileBytes &&
        fileCount <= limits.fileCount &&
        uncompressedBytes <= limits.uncompressedBytes
      if (!extractable) continue
      files.push({ path: relativePath, bytes: new Uint8Array(await readFile(absolutePath)) })
    }
  }

  await visit()
  const archive: SpecialistPackageArchiveMetrics = {
    compressedBytes: 0,
    uncompressedBytes,
    fileCount,
    limits
  }
  if (fileCount > limits.fileCount) {
    issue(
      diagnostics,
      'package.archive-file-count-exceeded',
      'The archive contains too many files.',
      undefined,
      { actual: fileCount, limit: limits.fileCount, unit: 'files' }
    )
  }
  if (uncompressedBytes > limits.uncompressedBytes) {
    issue(
      diagnostics,
      'package.archive-uncompressed-size-exceeded',
      'The expanded archive exceeds the safe preview limit.',
      undefined,
      {
        actual: uncompressedBytes,
        limit: limits.uncompressedBytes,
        unit: 'bytes'
      }
    )
  }
  if (diagnostics.some((entry) => entry.severity === 'error')) return { diagnostics, archive }
  return { files, diagnostics, archive }
}

export const validateSpecialistDirectory = async (
  root: string,
  catalog: SpecialistPackageCatalogSnapshot,
  source: Extract<SpecialistPackageSource, 'directory' | 'builtin'> = 'directory'
): Promise<SpecialistPackageValidationResult> => {
  try {
    const scanned = await scanDirectory(root)
    if (!scanned.files) {
      return {
        preview: {
          diagnostics: scanned.diagnostics,
          installable: false,
          archive: scanned.archive
        }
      }
    }
    const result = validateSpecialistPackage(scanned.files, catalog, source)
    return {
      ...result,
      preview: {
        ...result.preview,
        archive: scanned.archive
      }
    }
  } catch (error) {
    const symbolicLink = error instanceof Error && error.message === 'symbolic-link'
    const hardLink = error instanceof Error && error.message === 'hard-link'
    return {
      preview: {
        diagnostics: [
          {
            severity: 'error',
            code: symbolicLink
              ? 'package.symbolic-link-forbidden'
              : hardLink
                ? 'package.hard-link-forbidden'
                : 'package.directory-unreadable',
            message: symbolicLink
              ? 'Package directories cannot contain symbolic links.'
              : hardLink
                ? 'Package directories cannot contain hard links.'
                : 'The package directory could not be read.'
          }
        ],
        installable: false
      }
    }
  }
}

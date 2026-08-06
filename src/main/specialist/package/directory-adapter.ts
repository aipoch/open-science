import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  SpecialistPackageCatalogSnapshot,
  SpecialistPackageSource,
  SpecialistPackageValidationResult
} from '../../../shared/specialist-package'
import { validateSpecialistPackage, type SpecialistPackageFile } from './validator'

const readDirectoryFiles = async (
  root: string,
  relativeDirectory = ''
): Promise<SpecialistPackageFile[]> => {
  const files: SpecialistPackageFile[] = []
  const directory = relativeDirectory ? join(root, relativeDirectory) : root
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    const absolutePath = join(root, ...relativePath.split('/'))
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) throw new Error('symbolic-link')
    if (metadata.isFile() && metadata.nlink > 1) throw new Error('hard-link')
    if (entry.isDirectory()) {
      files.push(...(await readDirectoryFiles(root, relativePath)))
    } else if (entry.isFile()) {
      files.push({ path: relativePath, bytes: new Uint8Array(await readFile(absolutePath)) })
    }
  }
  return files
}

export const validateSpecialistDirectory = async (
  root: string,
  catalog: SpecialistPackageCatalogSnapshot,
  source: Extract<SpecialistPackageSource, 'directory' | 'builtin'> = 'directory'
): Promise<SpecialistPackageValidationResult> => {
  try {
    const files = await readDirectoryFiles(root)
    return validateSpecialistPackage(files, catalog, source)
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
